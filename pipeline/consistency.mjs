// Compares what a bank publishes through CDR with what its own web pages and PDFs say.
// A CDR rate or fee counts as "found" when the same figure appears on any page or PDF the
// product links to (or one click from those pages). "Not found" is a prompt to check,
// not proof of an error: pages can load figures with JavaScript or round them differently.
import { isProductPageField } from './web.mjs';

const TOL = 0.0051; // percentage points / dollars, so 6.19 matches 6.19 and 6.1900
const near = (list, v) => list.some((x) => Math.abs(x - v) < TOL);
function closest(list, v, n = 3) {
  return [...list].sort((a, b) => Math.abs(a - v) - Math.abs(b - v)).slice(0, n);
}
const LABEL = { OWNER_OCCUPIED: 'owner-occupied', INVESTMENT: 'investment', PRINCIPAL_AND_INTEREST: 'P&I', INTEREST_ONLY: 'interest only' };
function describeRate(r) {
  const bits = [r.type.toLowerCase().replace(/_/g, ' ')];
  if (r.term) bits.push(r.term % 12 === 0 ? `${r.term / 12} yr` : `${Math.round(r.term)} mth`);
  if (LABEL[r.purpose]) bits.push(LABEL[r.purpose]);
  if (LABEL[r.repay]) bits.push(LABEL[r.repay]);
  if (r.lvrMax !== null && r.lvrMax !== undefined) bits.push(`LVR up to ${r.lvrMax}%`);
  if (r.balMin) bits.push(`balance from $${r.balMin.toLocaleString('en-AU')}`);
  return bits.join(', ');
}

/**
 * @param {object[]} products normalised products of one brand
 * @param {object[]} rates normalised rates of the brand
 * @param {{docs, productUrls, children}} web result of readBrand
 * @returns {{ checks: object[], links: object[], issues: object[], summary: object }}
 */
// A failed fetch is only a broken link when the page is really missing (404, 410, unknown
// domain, invalid certificate). Timeouts, dropped connections, server hiccups, bot walls (405)
// and certificate chains browsers repair themselves are counted as "couldn't check" instead.
const REAL_FAILURE = /ENOTFOUND|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_INVALID_URL/;
export function failure(d) {
  const s = d.status;
  if (s === 405) return 'blocked';
  if (s >= 400 && s < 500) return 'broken';
  if (s >= 500) return 'unchecked';
  if (s && s < 400) return 'unchecked'; // page answered but we couldn't read it (too large, timed out mid-way)
  return REAL_FAILURE.test(d.error || '') ? 'broken' : 'unchecked';
}

export function compareBrand(products, rates, web) {
  const issues = [];
  const checks = [];
  const ratesByKey = new Map();
  for (const r of rates) if (r.comparable) (ratesByKey.get(r.k) || ratesByKey.set(r.k, []).get(r.k)).push(r);

  // ---- Link health, attributed to every product that uses the link
  const linkRows = new Map();
  for (const p of products) {
    for (const { url, field } of web.productUrls.get(p.key) || []) {
      const d = web.docs.get(url);
      if (!d) continue;
      let homepage = d.homepage;
      try {
        const f = new URL(d.finalUrl || url);
        if (isProductPageField(field) && (f.pathname === '/' || f.pathname === '') && !f.search) homepage = true;
      } catch {}
      const status = d.skipped
        ? 'skipped'
        : d.robots
          ? 'robots'
          : d.blocked
            ? 'blocked'
            : d.error && /invalid URL/.test(d.error)
              ? 'invalid'
              : !d.ok
                ? failure(d)
                : homepage && isProductPageField(field)
                  ? 'homepage'
                  : 'ok';
      const row = linkRows.get(url) || { url, finalUrl: d.finalUrl, status, httpStatus: d.status, error: d.error, kind: d.kind, title: d.title, notHttps: d.notHttps, rendered: d.rendered, fields: new Set(), products: [] };
      row.fields.add(field);
      if (row.products.length < 50) row.products.push(p.name);
      linkRows.set(url, row);
      const base = { productId: p.productId, product: p.name, field, value: url };
      if (status === 'broken' || status === 'invalid') issues.push({ code: 'LINK_BROKEN', ...base, detail: d.error || `HTTP ${d.status}` });
      if (status === 'unchecked') issues.push({ code: 'LINK_UNCHECKED', ...base, detail: d.error || `HTTP ${d.status}` });
      if (status === 'homepage') issues.push({ code: 'LINK_HOMEPAGE', ...base, detail: d.finalUrl });
      if (status === 'blocked') issues.push({ code: 'LINK_BLOCKED', ...base, detail: d.status ? `HTTP ${d.status}` : null });
      if (status === 'robots') issues.push({ code: 'LINK_ROBOTS', ...base });
      if (d.notHttps) issues.push({ code: 'LINK_NOT_HTTPS', ...base });
    }
  }

  // ---- Rates and fees vs page/PDF content
  let ratesChecked = 0, ratesFound = 0, feesChecked = 0, feesFound = 0, unverifiable = 0;
  for (const p of products) {
    const own = (web.productUrls.get(p.key) || []).map((x) => x.url);
    const all = [...new Set([...own, ...own.flatMap((u) => web.children.get(u) || [])])];
    const readable = all.map((u) => web.docs.get(u)).filter((d) => d?.ok && d.textLen > 120);
    // A page used by only this product (or one other) is read in full. A shared page or PDF is only
    // read in the section about this product, so another product's figures can't count as a match.
    const pctSet = new Set();
    const amtSet = new Set();
    const sources = [];
    for (const d of readable) {
      const specific = own.includes(d.url) && (web.refs?.get(d.url) ?? 1) <= 2;
      let use = null;
      if (specific) use = d;
      else if (d.byName?.[p.name]) use = d.byName[p.name];
      else if (!d.mentionsAny) use = d;
      if (!use) continue;
      use.pct.forEach((x) => pctSet.add(x));
      use.amt.forEach((x) => amtSet.add(x));
      sources.push({ url: d.finalUrl || d.url, kind: d.kind, linked: !!d.linked, scope: use === d ? 'page' : 'section' });
    }
    const pct = [...pctSet];
    const amt = [...amtSet];
    const rateRows = [];
    const seen = new Set();
    for (const r of ratesByKey.get(p.key) || []) {
      for (const [kind, v] of [['rate', r.rate], ['comparison', r.comp]]) {
        if (v === null || v === undefined || v <= 0) continue;
        const sig = `${kind}|${v.toFixed(4)}`;
        if (seen.has(sig)) continue; // the same figure across tiers only needs checking once
        seen.add(sig);
        rateRows.push({ kind, what: kind === 'comparison' ? `comparison rate (${describeRate(r)})` : describeRate(r), value: Math.round(v * 10000) / 10000 });
      }
    }
    const feeRows = (p.fees || [])
      .filter((f) => f.amount > 0 && ['PERIODIC', 'UPFRONT', 'EXIT', 'LATE_PAYMENT', 'EVENT', 'VARIATION'].includes(f.type))
      .slice(0, 20)
      .map((f) => ({ kind: 'fee', what: f.name || f.type.toLowerCase(), value: f.amount }));

    if (!rateRows.length && !feeRows.length) continue;
    if (!sources.length) {
      unverifiable++;
      const why = !all.length ? 'no links published' : all.every((u) => web.docs.get(u)?.blocked || web.docs.get(u)?.robots) ? 'pages blocked automated checks' : 'pages could not be read';
      checks.push({ k: p.key, product: p.name, category: p.category, status: 'unverifiable', why, sources: [], items: [] });
      issues.push({ code: 'WEB_UNVERIFIABLE', productId: p.productId, product: p.name, detail: why });
      continue;
    }
    const items = [];
    for (const row of rateRows) {
      const found = near(pct, row.value);
      ratesChecked++;
      if (found) ratesFound++;
      else issues.push({ code: row.kind === 'comparison' ? 'WEB_COMP_NOT_FOUND' : 'WEB_RATE_NOT_FOUND', productId: p.productId, product: p.name, field: row.what, value: `${row.value.toFixed(2)}%`, detail: pct.length ? `closest on page: ${closest(pct, row.value).map((x) => x.toFixed(2) + '%').join(', ')}` : 'no rates on the linked pages' });
      items.push({ ...row, found, closest: found ? [] : closest(pct, row.value) });
    }
    for (const row of feeRows) {
      const found = near(amt, row.value);
      feesChecked++;
      if (found) feesFound++;
      else issues.push({ code: 'WEB_FEE_NOT_FOUND', productId: p.productId, product: p.name, field: row.what, value: `$${row.value.toFixed(2)}`, detail: amt.length ? `closest on page: ${closest(amt, row.value).map((x) => '$' + x.toFixed(2)).join(', ')}` : 'no amounts on the linked pages' });
      items.push({ ...row, found, closest: found ? [] : closest(amt, row.value) });
    }
    const missing = items.filter((i) => !i.found).length;
    checks.push({ k: p.key, product: p.name, category: p.category, status: missing ? 'mismatch' : 'match', sources, items });
  }

  const links = [...linkRows.values()].map((r) => ({ ...r, fields: [...r.fields] }));
  const count = (s) => links.filter((l) => l.status === s).length;
  return {
    checks,
    links,
    issues,
    summary: {
      urls: links.length,
      linksOk: count('ok'),
      linksBroken: count('broken') + count('invalid'),
      linksHomepage: count('homepage'),
      linksBlocked: count('blocked'),
      linksRobots: count('robots'),
      linksSkipped: count('skipped') + count('unchecked'),
      pdfsRead: [...web.docs.values()].filter((d) => d.ok && d.kind === 'pdf').length,
      pagesRead: [...web.docs.values()].filter((d) => d.ok && d.kind === 'html').length,
      ratesChecked,
      ratesFound,
      feesChecked,
      feesFound,
      productsChecked: checks.filter((c) => c.status !== 'unverifiable').length,
      productsMatched: checks.filter((c) => c.status === 'match').length,
      productsUnverifiable: unverifiable,
    },
  };
}
