#!/usr/bin/env node
// Daily energy refresh: AER-published generic plans for every retailer → normalised plans,
// cost-based rankings, insights and data quality → site/data/energy/*.json
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.mjs';
import { getJson, getAllPages, stats } from '../http.mjs';
import { normalisePlan } from './normalise.mjs';
import { checkPlan, checkAccuracy, ENERGY_CDS } from './standards.mjs';
import { typicalCosts, buildEnergyInsights, diffPlans } from './insights.mjs';
import { fetchDoc, webStats, closeBrowser } from '../web.mjs';
import { resolveWebsite, crawlRetailer } from './factsheets.mjs';
import { failure } from '../consistency.mjs';
import { summarise, fieldKey, CATEGORIES, LEVELS } from '../dq.mjs';
import { DEFAULTS, GST } from '../../site/energy-cost.js';
import { recordDay, historySummary } from './archive.mjs';

const E = config.energy;
const OUT = E.outDir;
const t0 = Date.now();
const log = (...a) => console.log(`[energy ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'ACT', 'TAS', 'WA', 'NT'];
const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};

async function loadPrevious() {
  const prev = new Map();
  try {
    for (const f of await readdir(OUT)) if (/^plans-[A-Z]+\.json$/.test(f)) for (const p of (await readJson(join(OUT, f))) || []) prev.set(p.id, p);
  } catch {}
  const std = (await readJson(join(OUT, 'cache', 'standards.json'))) || {};
  return { prev, std };
}

// Rotate which plans get their fact sheets checked: a different sample each day
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const dayKey = new Date().toISOString().slice(0, 10);

async function main() {
  if (!E.enabled) return log('Energy is switched off (CDR_ENERGY=0).');
  await mkdir(OUT, { recursive: true });
  const { retailers } = JSON.parse(await readFile(E.retailersFile, 'utf8'));
  const host = (u) => (E.baseOverride ? u.replace('https://cdr.energymadeeasy.gov.au', E.baseOverride) : u);
  const filter = config.brandFilter;
  const chosen = retailers.filter((r) => !filter.length || filter.some((f) => r.name.toLowerCase().includes(f) || r.brand.includes(f)));
  const feeds = [...new Map(chosen.map((r) => [host(r.baseUri), []])).keys()];
  const nameByBrand = new Map(retailers.map((r) => [r.brand, r.name]));
  const { prev, std: stdCache } = await loadPrevious();
  log(`${chosen.length} retailers on ${feeds.length} feeds; ${prev.size} plans from the previous run`);

  // 1. Plan lists (cheap; include geography and lastUpdated)
  const feedResults = await Promise.all(
    feeds.map(async (base) => {
      try {
        const { items, version } = await getAllPages(`${base}/cds-au/v1/energy/plans?effective=CURRENT&page-size=${E.pageSize}`, E.listVersion, 'plans').catch((e) => {
          if (e.status === 400 || e.status === 422) return getAllPages(`${base}/cds-au/v1/energy/plans`, E.listVersion, 'plans');
          throw e;
        });
        return { base, ok: true, items, version };
      } catch (e) {
        return { base, ok: false, items: [], error: e.message };
      }
    })
  );
  const items = [];
  for (const f of feedResults) for (const it of f.items) items.push({ ...it, _base: f.base });
  log(`Listed ${items.length} current plans (${feedResults.filter((f) => !f.ok).length} feeds failed)`);

  // 2. Plan detail, only for new or changed plans
  const deadline = Date.now() + E.detailBudgetMs;
  const plans = [];
  const stdByPlan = {};
  const issuesByPlan = new Map();
  const counts = { reused: 0, fetched: 0, failed: 0, deferred: 0 };
  const seen = new Set();
  const defer = (it, old, extra) => {
    counts.deferred++;
    extra.push({ code: 'DETAIL_DEFERRED' });
    plans.push(old ? { ...old, stale: true } : normalisePlan({ ...it, _detailMissing: true }, nameByBrand.get(it.brand)));
    stdByPlan[it.planId] = stdCache[it.planId] || { v: null, issues: [] };
    issuesByPlan.set(it.planId, extra);
  };
  // Plans needing detail. Interleave retailers (and put residential market plans first) so that
  // when the time budget runs out, every retailer has its most useful plans covered.
  const need = [];
  for (const it of items) {
    if (seen.has(it.planId)) continue;
    seen.add(it.planId);
    const old = prev.get(it.planId);
    if (old && old.up === it.lastUpdated && old.detail && stdCache[it.planId]) {
      counts.reused++;
      plans.push(old);
      stdByPlan[it.planId] = stdCache[it.planId];
    } else need.push(it);
  }
  const rank = (it) => (it.type === 'MARKET' ? 0 : 1) + (it.customerType === 'BUSINESS' ? 2 : 0);
  const byB = new Map();
  for (const it of need.sort((a, b) => rank(a) - rank(b))) (byB.get(it.brand) || byB.set(it.brand, []).get(it.brand)).push(it);
  const queue = [];
  for (let i = 0, more = true; more; i++) {
    more = false;
    for (const list of byB.values()) if (list[i]) queue.push(list[i]), (more = true);
  }
  log(`${queue.length} plans need detail (${counts.reused} unchanged); budget ${Math.round(E.detailBudgetMs / 60e3)} min with ${E.detailConcurrency} workers`);
  // A fixed pool of workers; each checks the clock before every request, so the budget really holds.
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < queue.length) {
      const it = queue[next++];
      const old = prev.get(it.planId);
      const extra = [];
      if (Date.now() > deadline) {
        defer(it, old, extra);
        continue;
      }
      try {
        const { json, version } = await getJson(`${it._base}/cds-au/v1/energy/plans/${encodeURIComponent(it.planId)}`, E.detailVersion);
        const merged = { ...it, ...(json.data || {}), _xv: version };
        delete merged._base;
        counts.fetched++;
        plans.push(normalisePlan(merged, nameByBrand.get(it.brand)));
        stdByPlan[it.planId] = { v: version, issues: checkPlan(merged).map((i) => [i.code, i.path, i.value, i.msg]) };
      } catch (e) {
        counts.failed++;
        extra.push({ code: 'E_DETAIL_FAILED', value: e.message });
        plans.push(old ? { ...old, stale: true } : normalisePlan({ ...it, _detailMissing: true }, nameByBrand.get(it.brand)));
        stdByPlan[it.planId] = stdCache[it.planId] || { v: null, issues: [] };
      }
      issuesByPlan.set(it.planId, extra);
      if (++done % 1000 === 0) log(`  detail ${done}/${queue.length} (${counts.failed} failed)`);
    }
  }
  await Promise.all(Array.from({ length: E.detailConcurrency }, worker));
  for (const p of plans) if (typeof p.b === 'string') p.b = p.b.trim(); // some feeds pad brand ids with spaces
  log(`Plan detail: ${counts.fetched} fetched, ${counts.reused} unchanged, ${counts.failed} failed, ${counts.deferred} deferred to the next run`);
  if (!plans.length && prev.size) throw new Error('No energy plans this run — keeping the previous data.');

  // 3. Costs, rankings, insights, changes. Plans with data errors (e.g. prices in cents) are kept
  // in the data but flagged, so they can never top a ranking.
  const BLOCKING = new Set(['E_PRICE_IN_CENTS', 'E_NO_TARIFFS', 'E_FIT_IMPLAUSIBLE']);
  for (const p of plans) p.bad = p.detail && checkAccuracy(p).some((x) => BLOCKING.has(x.code));
  typicalCosts(plans);
  const { boards, insights } = buildEnergyInsights(plans);
  const changes = diffPlans([...prev.values()], plans);
  if (changes.length) {
    const ups = changes.filter((c) => c.delta > 0).length;
    const top = changes[0];
    insights.unshift({
      id: 'changes',
      group: 'Changes',
      headline: `${changes.length.toLocaleString('en-AU')} plan${changes.length > 1 ? 's' : ''} changed price since the last check (${ups} up, ${changes.length - ups} down)`,
      detail: `Biggest move: ${top.retailer} ${top.plan} (${top.fuel === 'E' ? 'electricity' : 'gas'}), about $${top.from.toLocaleString('en-AU')} to $${top.to.toLocaleString('en-AU')} a year at typical use.`,
    });
  }

  // 4. Fact sheets: links in the plan's CDR data (when published) and the retailer's own website
  const byBrand = new Map();
  for (const p of plans) (byBrand.get(p.b) || byBrand.set(p.b, []).get(p.b)).push(p);
  const hasLinks = (p) => Object.values(p.links || {}).some(Boolean);
  const hasDocLinks = (p) => !!(p.links?.pricing || p.links?.overview || p.links?.terms);
  const linksPublished = plans.filter(hasDocLinks).length;
  log(`${linksPublished} of ${plans.length} plans link to a fact sheet or plan page in their CDR data`);
  const web = new Map(); // brand -> { sample, urls, docs, website, fs }
  if (E.web) {
    const wDeadline = Date.now() + E.webBudgetMs;
    await mkdir(join(OUT, 'cache'), { recursive: true });
    const configured = (await readJson(E.websitesFile))?.websites || {};
    const siteCache = (await readJson(join(OUT, 'cache', 'websites.json'))) || {};
    const fsIndex = (await readJson(join(OUT, 'cache', 'factsheets.json'))) || {};
    const info = new Map(retailers.map((r) => [r.brand.trim(), r]));
    await Promise.all(
      [...byBrand.entries()].map(async ([brand, list]) => {
        // a) links published in the CDR data
        const sample = list
          .filter((p) => p.detail && hasLinks(p))
          .sort((a, b) => hash(dayKey + a.id) - hash(dayKey + b.id))
          .slice(0, E.webPlansPerRetailer);
        const urls = new Map();
        for (const p of sample)
          for (const [field, u] of Object.entries(p.links)) {
            if (!u || field === 'eligibility') continue;
            if (!urls.has(u)) urls.set(u, { fields: new Set(), plans: [] });
            urls.get(u).fields.add(field);
            urls.get(u).plans.push(p);
          }
        const docs = new Map();
        await Promise.all([...urls.keys()].map(async (u) => docs.set(u, await fetchDoc(u, wDeadline))));
        // b) the retailer's website
        const r = info.get(brand);
        const name = r?.name || list[0]?.r || brand;
        const ws = await resolveWebsite({ brand, name, configured: r && 'website' in r ? r.website : configured[brand], cached: siteCache[brand], deadline: wDeadline, today: dayKey });
        if (ws.how === 'guessed' || ws.how === 'not found') siteCache[brand] = { url: ws.url, at: dayKey };
        let fs = null;
        if (ws.url) {
          try {
            fs = await crawlRetailer({ website: ws.url, name, plans: list, index: fsIndex[brand], deadline: wDeadline, limits: E.factSheets, today: dayKey });
            fsIndex[brand] = fs.index;
          } catch (e) {
            log(`  ${name}: fact-sheet search failed (${e.message})`);
          }
        }
        web.set(brand, { sample, urls, docs, website: ws.url, fs });
      })
    );
    await closeBrowser();
    await writeFile(join(OUT, 'cache', 'websites.json'), JSON.stringify(siteCache));
    await writeFile(join(OUT, 'cache', 'factsheets.json'), JSON.stringify(fsIndex));
    const ws = [...web.values()];
    log(`Websites known for ${ws.filter((w) => w.website).length} of ${ws.length} retailers; fact sheets found for ${ws.reduce((a, w) => a + (w.fs?.stats.plansCovered || 0), 0)} plans; checked ${ws.reduce((a, w) => a + (w.fs?.sample.length || 0) + w.sample.length, 0)} today`);
  }

  // 5. Assemble data quality per retailer brand
  await rm(join(OUT, 'dq'), { recursive: true, force: true });
  await mkdir(join(OUT, 'dq'), { recursive: true });
  const quality = [];
  const near = (list, v) => list.some((x) => Math.abs(x - v) < 0.011);
  const brandsSeen = new Set([...byBrand.keys()]);
  // feeds that failed: attribute to every retailer listed on them
  for (const f of feedResults.filter((x) => !x.ok)) for (const r of chosen.filter((r) => host(r.baseUri) === f.base)) if (!brandsSeen.has(r.brand)) byBrand.set(r.brand, []), brandsSeen.add(r.brand);

  for (const [brand, list] of byBrand) {
    const retailer = list[0]?.r || nameByBrand.get(brand) || brand;
    const feed = feedResults.find((f) => chosen.some((r) => r.brand === brand && host(r.baseUri) === f.base));
    const all = [];
    if (feed && !feed.ok) all.push({ code: 'E_FEED_FAILED', value: feed.error });
    const versions = {};
    let stdChecked = 0;
    let stdWith = 0;
    for (const p of list) {
      const s = stdByPlan[p.id];
      if (s?.v) {
        stdChecked++;
        versions[s.v] = (versions[s.v] || 0) + 1;
        if (s.issues.length) stdWith++;
        for (const [code, path, value, msg] of s.issues) all.push({ code, productId: p.id, product: p.n, field: path, value, detail: msg });
      }
      for (const x of issuesByPlan.get(p.id) || []) all.push({ ...x, productId: p.id, product: p.n });
      if (p.detail) for (const x of checkAccuracy(p)) all.push({ ...x, productId: p.id, product: p.n });
    }
    const older = Object.entries(versions).filter(([v]) => Number(v) < ENERGY_CDS.detail);
    for (const [v, n] of older) all.push({ code: 'VERSION_OLDER', value: `v${v}`, detail: `${n} plan${n > 1 ? 's' : ''} served at v${v}; the current standard (${ENERGY_CDS.spec}) is v${ENERGY_CDS.detail}` });

    // Links and fact sheets
    const w = web.get(brand);
    const links = [];
    const checks = [];
    const sum = { urls: 0, linksOk: 0, linksBroken: 0, linksHomepage: 0, linksBlocked: 0, linksRobots: 0, linksSkipped: 0, pdfsRead: 0, pagesRead: 0, ratesChecked: 0, ratesFound: 0, feesChecked: 0, feesFound: 0, productsChecked: 0, productsMatched: 0, productsUnverifiable: 0 };
    if (w) {
      for (const [u, { fields, plans: ps }] of w.urls) {
        const d = w.docs.get(u);
        let homepage = d.homepage;
        try {
          const f = new URL(d.finalUrl || u);
          if ((fields.has('overview') || fields.has('pricing')) && (f.pathname === '/' || !f.pathname)) homepage = true;
        } catch {}
        const status = d.skipped ? 'skipped' : d.robots ? 'robots' : d.blocked ? 'blocked' : !d.ok ? failure(d) : homepage && !fields.has('apply') ? 'homepage' : 'ok';
        sum.urls++;
        sum[{ ok: 'linksOk', broken: 'linksBroken', homepage: 'linksHomepage', blocked: 'linksBlocked', robots: 'linksRobots', skipped: 'linksSkipped', unchecked: 'linksSkipped' }[status]]++;
        if (d.ok && d.kind === 'pdf') sum.pdfsRead++;
        if (d.ok && d.kind === 'html') sum.pagesRead++;
        const code = { broken: 'LINK_BROKEN', homepage: 'LINK_HOMEPAGE', blocked: 'LINK_BLOCKED', robots: 'LINK_ROBOTS', unchecked: 'LINK_UNCHECKED' }[status];
        for (const p of ps.slice(0, 20)) {
          if (code) all.push({ code, productId: p.id, product: p.n, field: [...fields].join(', '), value: u, detail: d.status ? `HTTP ${d.status}` : d.error || d.finalUrl });
          if (d.notHttps) all.push({ code: 'LINK_NOT_HTTPS', productId: p.id, product: p.n, field: [...fields].join(', '), value: u });
        }
        if (status !== 'ok') links.push({ url: u, finalUrl: d.finalUrl, status, httpStatus: d.status, error: d.error, fields: [...fields], products: ps.slice(0, 5).map((p) => p.n) });
      }
      // Prices on fact sheets (shown including or excluding GST, in cents)
      const toCheck = new Map(); // planId -> { p, docs: [{ url, kind, values, failed }] }
      for (const p of w.sample) {
        const list = Object.entries(p.links)
          .filter(([f, u]) => u && ['pricing', 'overview'].includes(f))
          .map(([, u]) => {
            const d = w.docs.get(u);
            const failed = !d?.ok ? (d?.blocked ? 'blocked automated checks' : d?.robots ? 'excluded by robots.txt' : d?.skipped ? 'not read today (time limit)' : 'could not be read') : d.textLen <= 120 ? 'page was empty' : null;
            return { url: d?.finalUrl || u, kind: d?.kind, values: failed ? [] : d.cents || [], failed };
          });
        if (list.length) toCheck.set(p.id, { p, docs: list });
      }
      for (const p of w.fs?.sample || []) {
        const e = toCheck.get(p.id) || toCheck.set(p.id, { p, docs: [] }).get(p.id);
        e.docs.push(...(w.fs.planDocs.get(p.id) || []));
      }
      for (const { p, docs } of toCheck.values()) {
        const values = [...new Set(docs.flatMap((d) => d.values))];
        const items = [];
        for (const [fuel, c] of [['electricity', p.e], ['gas', p.g]]) {
          if (!c?.tp?.length) continue;
          const t = c.tp.find((x) => x.kind && x.kind !== 'demand');
          if (!t) continue;
          const want = [];
          if (t.sup) want.push({ kind: 'supply', what: `${fuel} daily supply`, v: t.sup });
          if (t.kind === 'single' && t.blocks[0]) want.push({ kind: 'price', what: `${fuel} usage rate`, v: t.blocks[0].p });
          if (t.kind === 'tou') for (const r of t.tou.slice(0, 3)) if (r.blocks[0]) want.push({ kind: 'price', what: `${fuel} ${String(r.type || r.name).toLowerCase().replace(/_/g, ' ')} rate`, v: r.blocks[0].p });
          for (const x of want) {
            const incl = x.v * 100 * (1 + GST);
            const excl = x.v * 100;
            const found = near(values, incl) || near(values, excl) || near(values, Math.round(incl * 100) / 100) || near(values, Math.round(excl * 100) / 100);
            items.push({ kind: x.kind === 'supply' ? 'fee' : 'rate', what: x.what, value: Math.round(incl * 100) / 100, found, closest: found ? [] : [...values].sort((a, b) => Math.abs(a - incl) - Math.abs(b - incl)).slice(0, 3) });
          }
        }
        if (!items.length) continue;
        const sources = docs.map((d) => ({ url: d.url, kind: d.kind }));
        if (!values.length && docs.every((d) => /time limit/.test(d.failed || ''))) continue; // ran out of time today: try again tomorrow
        if (!values.length) {
          // Nothing with prices on it could be read: not checked, not wrong
          const why = docs.find((d) => d.failed)?.failed ? `fact sheet ${docs.find((d) => d.failed).failed}` : 'no prices for this plan could be read from its fact sheet';
          sum.productsUnverifiable++;
          checks.push({ k: p.id, product: p.n, status: 'unverifiable', why, sources, items: [] });
          all.push({ code: 'WEB_UNVERIFIABLE', productId: p.id, product: p.n, value: sources[0]?.url || null, detail: why });
          continue;
        }
        sum.productsChecked++;
        for (const i of items) {
          sum.ratesChecked++;
          if (i.found) sum.ratesFound++;
          else all.push({ code: i.kind === 'fee' ? 'WEB_SUPPLY_NOT_FOUND' : 'WEB_PRICE_NOT_FOUND', productId: p.id, product: p.n, field: i.what, value: `${i.value.toFixed(2)}c incl. GST`, detail: `closest on the fact sheet: ${i.closest.map((v) => v.toFixed(2) + 'c').join(', ')} (${sources[0]?.url || ''})` });
        }
        const missing = items.filter((i) => !i.found);
        if (!missing.length) sum.productsMatched++, checks.push({ k: p.id, product: p.n, status: 'match', sources, items: [] });
        else checks.push({ k: p.id, product: p.n, status: 'mismatch', sources, items: missing.map((i) => ({ ...i, kind: 'cents' })) });
      }
      // Retailer-level findings about where fact sheets come from
      if (!list.some(hasDocLinks)) all.push({ code: 'E_NO_PLAN_LINKS', detail: `none of ${list.length.toLocaleString('en-AU')} plans include links (additionalInformation) to a fact sheet or plan page` });
      const viaCdr = list.some(hasDocLinks);
      if (!w.website && !viaCdr) all.push({ code: 'WEB_SITE_UNKNOWN', detail: 'add the retailer’s website to pipeline/energy/websites.json' });
      else if (w.fs) {
        const st = w.fs.stats;
        sum.website = w.website;
        sum.plansCovered = st.plansCovered;
        sum.factSheetsFound = st.docsFound;
        sum.pagesRead += st.pagesRead;
        sum.pdfsRead += st.pdfsRead;
        if (!st.plansCovered && !viaCdr) all.push({ code: 'WEB_NO_FACT_SHEETS', value: w.website, detail: `searched today: ${st.sitemapUrls ? `${st.sitemapUrls.toLocaleString('en-AU')} sitemap entries, ` : ''}${st.pagesRead} pages, ${st.pdfsRead} PDFs${st.blocked ? `; ${st.blocked} blocked automated checks` : ''}` });
      }
    }

    const S = summarise(all);
    const gkey = (i) => `${i.code}|${['SCHEMA_REQUIRED', 'SCHEMA_ENUM', 'SCHEMA_TYPE', 'RULE_CONDITIONAL'].includes(i.code) || i.code.startsWith('FORMAT_') ? fieldKey(i.field) : ''}|${i.level}`;
    // keep up to 150 examples of each finding for the report
    const perGroup = new Map();
    const kept = [];
    for (const i of S.described) {
      const k = gkey(i);
      const n = perGroup.get(k) || 0;
      if (n < 150) kept.push({ ...i, gk: k }), perGroup.set(k, n + 1);
    }
    const file = `energy/dq/${safe(brand)}.json`;
    await writeFile(join(OUT, 'dq', `${safe(brand)}.json`), JSON.stringify({ brandId: brand, brand: retailer, issues: kept.map(({ label, category, severity, ...i }) => i), truncated: false, links: links.slice(0, 400), checks: checks.slice(0, 400) }));
    quality.push({
      brandId: brand,
      brand: retailer,
      ok: !feed || feed.ok,
      total: S.described.length,
      findings: S.findings,
      notes: S.notes,
      levels: S.levels,
      affected: S.affected,
      errors: S.errors,
      warnings: S.warnings,
      infos: S.infos,
      byCategory: S.byCategory,
      issues: S.groups.map((g) => ({ ...g, gk: `${g.code}|${g.field || ''}|${g.level}` })),
      standards: { checked: stdChecked, withIssues: stdWith, versions },
      web: w ? sum : null,
      plans: list.length,
      file,
    });
  }

  // 6. Write outputs
  const byState = Object.fromEntries([...STATES, 'OTHER'].map((s) => [s, []]));
  for (const p of plans) {
    const states = p.st.length ? p.st : ['OTHER'];
    for (const s of states) (byState[s] || byState.OTHER).push(p);
  }
  for (const f of await readdir(OUT).catch(() => [])) if (/^plans-[A-Z]+\.json$/.test(f)) await rm(join(OUT, f));
  const stateMeta = {};
  for (const [s, list] of Object.entries(byState)) {
    if (!list.length) continue;
    list.sort((a, b) => a.r.localeCompare(b.r) || a.n.localeCompare(b.n) || a.id.localeCompare(b.id));
    await writeFile(join(OUT, `plans-${s}.json`), JSON.stringify(list));
    const networks = { E: {}, G: {} };
    for (const p of list) for (const fuel of ['E', 'G']) if ((fuel === 'E' ? p.e : p.g) && ['ELECTRICITY', 'GAS', 'DUAL'].includes(p.f)) for (const d of p.d) if ((fuel === 'E' && p.e) || (fuel === 'G' && p.g)) networks[fuel][d] = (networks[fuel][d] || 0) + 1;
    stateMeta[s] = { plans: list.length, file: `energy/plans-${s}.json`, networks };
  }
  await mkdir(join(OUT, 'cache'), { recursive: true });
  await writeFile(join(OUT, 'cache', 'standards.json'), JSON.stringify(stdByPlan));
  const prevChanges = (await readJson(join(OUT, 'changes.json'))) || { runs: [] };
  prevChanges.runs = [{ at: new Date().toISOString(), count: changes.length, changes: changes.slice(0, 300) }, ...(prevChanges.runs || [])].slice(0, 30);
  const retailersOut = [...byBrand.entries()].map(([b, list]) => ({ brand: b, name: list[0]?.r || nameByBrand.get(b) || b, plans: list.length, elec: list.filter((p) => p.e).length, gas: list.filter((p) => p.g).length, states: [...new Set(list.flatMap((p) => p.st))].sort() }));
  const serious = quality.filter((q) => q.levels[1] + q.levels[2]).sort((a, b) => b.levels[1] - a.levels[1] || b.levels[2] - a.levels[2]);
  if (serious.length) insights.push({ id: 'dq', group: 'Data quality', headline: `${serious.length} of ${quality.length} retailers have critical or major problems in their published plans`, detail: `For example ${serious.slice(0, 3).map((q) => `${q.brand} (${q.levels[1] + q.levels[2]})`).join(', ')}. See the data-quality report for details.` });

  // Price history: today's prices into the private archive (never fails the run)
  let history = null;
  if (E.archive.enabled) {
    if ((filter.length || E.baseOverride) && process.env.CDR_ARCHIVE_TEST !== '1') log('Price history skipped: only part of the market was read (brand filter or test feeds)');
    else
      try {
        const listed = new Map(items.map((it) => [it.planId, it._base]));
        const feedOk = new Map(feedResults.map((f) => [f.base, f.ok]));
        await recordDay({ dir: E.archive.dir, plans, listed, feedOk, log, ...(process.env.CDR_ARCHIVE_DATE ? { date: process.env.CDR_ARCHIVE_DATE } : {}) });
        history = await historySummary(E.archive.dir);
      } catch (e) {
        console.log(`::error::Price history not updated: ${e.message}`);
      }
  }

  await Promise.all([
    writeFile(join(OUT, 'boards.json'), JSON.stringify(boards)),
    writeFile(join(OUT, 'insights.json'), JSON.stringify(insights)),
    writeFile(join(OUT, 'changes.json'), JSON.stringify(prevChanges)),
    writeFile(join(OUT, 'retailers.json'), JSON.stringify(retailersOut.sort((a, b) => a.name.localeCompare(b.name)))),
    writeFile(join(OUT, 'quality.json'), JSON.stringify({ cds: ENERGY_CDS, categories: CATEGORIES, web: { enabled: E.web, stats: webStats }, levels: LEVELS, brands: quality.sort((a, b) => b.levels[1] - a.levels[1] || b.levels[2] - a.levels[2] || b.findings - a.findings || a.brand.localeCompare(b.brand)) })),
    writeFile(
      join(OUT, 'meta.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        retailers: retailersOut.filter((r) => r.plans).length,
        retailersListed: chosen.length,
        feeds: feeds.length,
        feedsOk: feedResults.filter((f) => f.ok).length,
        plansWithLinks: linksPublished,
        plans: plans.length,
        electricity: plans.filter((p) => p.e).length,
        gas: plans.filter((p) => p.g).length,
        detail: counts,
        states: stateMeta,
        history,
        defaults: DEFAULTS,
        cds: ENERGY_CDS,
        http: stats,
      })
    ),
  ]);
  log(`Done: ${plans.length} plans from ${retailersOut.filter((r) => r.plans).length} retailers, ${insights.length} insights, ${changes.length} price changes → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
