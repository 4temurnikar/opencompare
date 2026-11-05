#!/usr/bin/env node
// Daily refresh: CDR Register → every bank's product APIs → normalised data + insights → site/data/*.json
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import { stats } from './http.mjs';
import { fetchRegister, fetchBrand } from './fetch.mjs';
import { normaliseBrand, ISSUE_LABELS, CATEGORY_LABELS } from './normalise.mjs';
import { buildInsights, diffRates } from './insights.mjs';
import { checkProduct, CDS_VERSION } from './standards.mjs';
import { readBrand, webStats, closeBrowser } from './web.mjs';
import { compareBrand } from './consistency.mjs';
import { describe, CATEGORIES, SEVERITY_ORDER } from './dq.mjs';

const OUT = config.outDir;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const RATE_COLS = ['k', 'kind', 'cat', 'type', 'comparable', 'rate', 'comp', 'purpose', 'repay', 'term', 'lvrMin', 'lvrMax', 'balMin', 'balMax', 'tierNote', 'info'];
const PRODUCT_COLS = ['key', 'brandId', 'brand', 'productId', 'name', 'category', 'uri', 'tailored', 'business', 'staff', 'special', 'lastUpdated', 'features', 'offset', 'redraw', 'yearlyFees', 'monthlyFee', 'upfrontFees', 'detailMissing'];
const columnar = (cols, rows) => ({ columns: cols, rows: rows.map((r) => cols.map((c) => r[c] ?? null)) });
const fromColumnar = (d) => (d?.rows || []).map((row) => Object.fromEntries(d.columns.map((c, i) => [c, row[i]])));
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
const writeJson = (name, data) => writeFile(join(OUT, name), JSON.stringify(data));

// Files the banking build publishes in site/data; removed from the public site when banking is private or off.
const BANKING_FILES = ['meta.json', 'insights.json', 'boards.json', 'products.json', 'rates.json', 'brands.json', 'quality.json', 'changes.json'];
async function clearPublicBanking() {
  await Promise.all([...BANKING_FILES.map((f) => rm(join(config.siteData, f), { force: true })), rm(join(config.siteData, 'details'), { recursive: true, force: true }), rm(join(config.siteData, 'dq'), { recursive: true, force: true })]);
}

async function main() {
  if (config.bankingMode !== 'public' && !process.env.CDR_OUT_DIR) await clearPublicBanking();
  if (config.bankingMode === 'off') {
    log('Banking is switched off (CDR_BANKING=off); nothing to do.');
    return;
  }
  log(`Banking mode: ${config.bankingMode}; writing to ${OUT}`);
  await mkdir(join(OUT, 'details'), { recursive: true });
  const prevRates = fromColumnar(await readJson(join(OUT, 'rates.json')));
  const prevChanges = (await readJson(join(OUT, 'changes.json'))) || { runs: [] };

  log('Fetching CDR Register…');
  const brands = await fetchRegister();
  log(`${brands.length} banking brands with a public base URI`);
  if (!brands.length) throw new Error('CDR Register returned no banking brands — aborting so yesterday’s data is kept.');

  let done = 0;
  const results = await Promise.all(
    brands.map(async (b) => {
      const r = await fetchBrand(b);
      done++;
      log(`${String(done).padStart(3)}/${brands.length} ${r.ok ? 'OK  ' : 'FAIL'} ${b.brandName} — ${r.products.length} products${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
      return r;
    })
  );

  const products = [];
  const rates = [];
  const quality = [];
  const brandRows = [];
  await rm(join(OUT, 'details'), { recursive: true, force: true });
  await mkdir(join(OUT, 'details'), { recursive: true });
  await rm(join(OUT, 'dq'), { recursive: true, force: true });
  await mkdir(join(OUT, 'dq'), { recursive: true });

  if (process.env.CDR_SAVE_RAW) {
    await mkdir(join(OUT, '..', '..', 'raw'), { recursive: true });
  }

  // 1. Normalise every brand
  const perBrand = results.map((r) => ({ r, ...normaliseBrand(r.brand, r.products) }));
  for (const b of perBrand) {
    products.push(...b.products);
    rates.push(...b.rates);
  }

  // 2. Read the web pages and PDFs each bank links to from its CDR data
  const webByBrand = new Map();
  if (config.web.enabled) {
    const deadline = Date.now() + config.web.timeBudgetMs;
    let webDone = 0;
    const withProducts = perBrand.filter((b) => b.r.products.length);
    log(`Reading bank websites and PDFs for ${withProducts.length} brands (budget ${config.web.timeBudgetMs / 60e3} min)…`);
    await Promise.all(
      withProducts.map(async ({ r }) => {
        try {
          const web = await readBrand(r.brand, r.products, (p) => `${r.brand.brandId}:${p.productId}`, deadline);
          webByBrand.set(r.brand.brandId, web);
          const docs = [...web.docs.values()];
          webDone++;
          log(`web ${String(webDone).padStart(3)}/${withProducts.length} ${r.brand.brandName} — ${docs.filter((d) => d.ok).length}/${docs.length} pages read, ${docs.filter((d) => d.ok && d.kind === 'pdf').length} PDFs, ${docs.filter((d) => d.blocked).length} blocked`);
        } catch (e) {
          log(`web ${r.brand.brandName} failed: ${e.message}`);
        }
      })
    );
    await closeBrowser();
  }

  // 3. Assemble every data-quality finding per brand
  const BRAND_ISSUE_CAP = 1200; // keeps the daily data commit small; totals still count everything
  for (const { r, products: ps, rates: rs, issues } of perBrand) {
    const id = safe(r.brand.brandId);
    if (process.env.CDR_SAVE_RAW) await writeFile(join(OUT, '..', '..', 'raw', `${id}.json`), JSON.stringify(r.products, null, 1));

    // full details for the product drawer, one file per brand (loaded on demand)
    if (ps.length) {
      const det = Object.fromEntries(ps.map((p) => [p.key, { description: p.description, fees: p.fees, eligibility: p.eligibility, constraints: p.constraints, overviewUri: p.overviewUri, feesUri: p.feesUri, effectiveFrom: p.effectiveFrom }]));
      await writeFile(join(OUT, 'details', `${id}.json`), JSON.stringify(det));
    }

    // Standards conformance, product by product
    const std = [];
    let stdChecked = 0, stdWithIssues = 0;
    const older = {};
    for (const raw of r.products) {
      if (raw._detailMissing) continue;
      stdChecked++;
      const found = checkProduct(raw);
      if (found.length) stdWithIssues++;
      for (const i of found) std.push({ ...i, productId: raw.productId, product: raw.name, field: i.path, detail: i.msg });
      if (Number(raw._xv) < CDS_VERSION.detail) older[raw._xv] = (older[raw._xv] || 0) + 1;
    }
    const versionIssues = Object.entries(older).map(([v, n]) => ({ code: 'VERSION_OLDER', value: `v${v}`, detail: `${n} product${n > 1 ? 's' : ''} served at v${v}; the current standard (${CDS_VERSION.spec}) is v${CDS_VERSION.detail}` }));

    // Website and PDF consistency
    const web = webByBrand.get(r.brand.brandId);
    const cmp = web ? compareBrand(ps, rs, web) : null;

    const all = [
      ...r.errors.map((e) => ({ code: e.stage === 'list' ? 'LIST_FAILED' : 'DETAIL_FAILED', productId: e.productId ?? null, value: e.message })),
      ...(r.ok && !ps.length ? [{ code: 'NO_PRODUCTS', value: 'Products endpoint responded but listed no products' }] : []),
      ...versionIssues,
      ...std,
      ...issues,
      ...(cmp?.issues || []),
    ].map((i) => ({ ...i, ...describe(i.code), product: i.product ?? null }));
    all.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const byCode = {};
    for (const i of all) {
      const g = (byCode[i.code] ??= { code: i.code, label: i.label, category: i.category, severity: i.severity, count: 0, products: new Set(), examples: [] });
      g.count++;
      if (i.productId) g.products.add(i.productId);
      if (g.examples.length < 3) g.examples.push({ product: i.product, field: i.field ?? null, value: i.value ?? null, detail: i.detail ?? null });
    }
    const groups = Object.values(byCode)
      .map((g) => ({ ...g, products: g.products.size }))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);
    const count = (sev) => all.filter((i) => i.severity === sev).length;
    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, all.filter((i) => i.category === c.id && i.severity !== 'info').length]));

    await writeFile(
      join(OUT, 'dq', `${id}.json`),
      JSON.stringify({
        brandId: r.brand.brandId,
        brand: r.brand.brandName,
        issues: all.slice(0, BRAND_ISSUE_CAP).map(({ label, category, severity, ...i }) => i),
        truncated: all.length > BRAND_ISSUE_CAP,
        codes: Object.fromEntries(groups.map((g) => [g.code, { label: g.label, category: g.category, severity: g.severity }])),
        links: (cmp?.links || []).filter((l) => l.status !== 'ok').slice(0, 600).map((l) => ({ ...l, products: l.products.slice(0, 5) })),
        checks: (cmp?.checks || []).filter((c) => c.status !== 'match').slice(0, 600).map((c) => ({ ...c, items: c.items.filter((i) => !i.found), sources: c.sources.slice(0, 6) })),
      })
    );
    quality.push({
      brandId: r.brand.brandId,
      brand: r.brand.brandName,
      ok: r.ok,
      total: all.length,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      byCategory,
      issues: groups,
      standards: { checked: stdChecked, withIssues: stdWithIssues, versions: r.detailVersions },
      web: cmp?.summary || null,
      file: `dq/${id}.json`,
    });

    const cats = {};
    for (const p of ps) cats[p.category] = (cats[p.category] || 0) + 1;
    brandRows.push({
      brandId: r.brand.brandId,
      brand: r.brand.brandName,
      logoUri: r.brand.logoUri,
      baseUri: r.brand.publicBaseUri,
      ok: r.ok,
      products: ps.length,
      categories: cats,
      listVersion: r.listVersion,
      detailVersions: r.detailVersions,
      errors: r.errors.length,
      issues: all.length,
      durationMs: r.durationMs,
      detailFile: ps.length ? `details/${id}.json` : null,
    });
  }

  log(`Normalised ${products.length} products, ${rates.length} rate rows`);
  const okCount = results.filter((r) => r.ok).length;
  if (okCount < Math.max(1, brands.length * 0.3))
    throw new Error(`Only ${okCount}/${brands.length} brands responded — refusing to overwrite data (likely a network problem).`);

  const { boards, insights } = buildInsights({ products, rates });
  const changes = diffRates(prevRates, rates, products);
  const today = new Date().toISOString();

  if (changes.length) {
    const ups = changes.filter((c) => c.delta > 0).length;
    const top = changes[0];
    insights.unshift({
      id: 'changes',
      group: 'Changes',
      tone: 'change',
      headline: `${changes.length} rate change${changes.length > 1 ? 's' : ''} since the last refresh (${ups} up, ${changes.length - ups} down)`,
      detail: `Biggest move: ${top.brand} ${top.product} ${top.type.toLowerCase()} ${top.from.toFixed(2)}% → ${top.to.toFixed(2)}%.`,
      brands: [...new Set(changes.slice(0, 5).map((c) => c.brandId))],
    });
  }
  const dqWorst = quality.filter((q) => q.errors + q.warnings).sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
  if (dqWorst.length)
    insights.push({
      id: 'dq',
      group: 'Data quality',
      tone: 'dq',
      headline: `${dqWorst.length} of ${brands.length} brands have data-quality issues in their published product data`,
      detail: `Most errors: ${dqWorst.slice(0, 3).map((q) => `${q.brand} (${q.errors})`).join(', ')}. See the Data quality report; affected rates may be missing from comparisons.`,
      brands: dqWorst.slice(0, 3).map((q) => q.brandId),
    });

  prevChanges.runs = [{ at: today, count: changes.length, changes: changes.slice(0, 300) }, ...(prevChanges.runs || [])].slice(0, config.historyDays);

  const catCounts = {};
  for (const p of products) catCounts[p.category] = (catCounts[p.category] || 0) + 1;

  await Promise.all([
    writeJson('rates.json', columnar(RATE_COLS, rates)),
    writeJson('products.json', columnar(PRODUCT_COLS, products)),
    writeJson('brands.json', brandRows),
    writeJson('boards.json', boards),
    writeJson('insights.json', insights),
    writeJson('quality.json', {
      cds: CDS_VERSION,
      categories: CATEGORIES,
      web: { enabled: config.web.enabled, rendered: config.web.render, stats: webStats },
      brands: quality.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || a.brand.localeCompare(b.brand)),
    }),
    writeJson('changes.json', prevChanges),
    writeJson('meta.json', {
      generatedAt: today,
      durationMs: Date.now() - t0,
      registerUrl: config.registerUrl,
      brandsTotal: brands.length,
      brandsOk: okCount,
      products: products.length,
      rates: rates.length,
      categories: Object.entries(catCounts).map(([id, n]) => ({ id, label: CATEGORY_LABELS[id] || id, n })).sort((a, b) => b.n - a.n),
      scenarios: config.scenarios,
      http: stats,
      web: config.web.enabled ? webStats : null,
      cds: CDS_VERSION,
    }),
  ]);
  log(`Done: ${okCount}/${brands.length} brands OK, ${insights.length} insights, ${changes.length} changes. Output → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
