#!/usr/bin/env node
// Local mock of the CDR Register + data holder product APIs, for testing without internet.
// Brands are FICTIONAL; payloads follow the CDS BankingProductDetail schema.
// MOCK_SHIFT=1 nudges some rates so you can test day-on-day change detection.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8787);
const SHIFT = Number(process.env.MOCK_SHIFT || 0);
const base = `http://localhost:${PORT}`;
const d = (pct) => (pct / 100).toFixed(4); // percent → CDR RateString

const lvrTier = (min, max) => ({ name: 'LVR', unitOfMeasure: 'PERCENT', minimumValue: min, maximumValue: max, rateApplicationMethod: 'WHOLE_BALANCE' });
const balTier = (min, max) => ({ name: 'Balance', unitOfMeasure: 'DOLLAR', minimumValue: min, ...(max ? { maximumValue: max } : {}), rateApplicationMethod: 'WHOLE_BALANCE' });

function mortgage(b, { id, name, ooVar, invVar, ioLoad = 0.45, fixed = {}, invFixedLoad = 0.3, offset = false, lvrSteps = [0, 0.1, 0.4], annual = 0, scale = false, noComp = false }) {
  const rate = (p) => (scale ? p.toFixed(2) : d(p)); // scale=true publishes 6.19 instead of 0.0619 (DQ test)
  const bands = [[0, 60], [60, 80], [80, 90]];
  const lendingRates = [];
  for (const [purpose, v] of [['OWNER_OCCUPIED', ooVar], ['INVESTMENT', invVar]]) {
    for (const [repay, load] of [['PRINCIPAL_AND_INTEREST', 0], ['INTEREST_ONLY', ioLoad]]) {
      bands.forEach(([mn, mx], i) => {
        const r = v + load + lvrSteps[i];
        lendingRates.push({ lendingRateType: 'VARIABLE', rate: rate(r), ...(noComp ? {} : { comparisonRate: rate(r + 0.04 + annual / 3000) }), calculationFrequency: 'P1D', applicationFrequency: 'P1M', loanPurpose: purpose, repaymentType: repay, tiers: [lvrTier(mn, mx)] });
      });
      for (const [term, fr] of Object.entries(fixed)) {
        const r = fr + (purpose === 'INVESTMENT' ? invFixedLoad : 0) + load;
        lendingRates.push({ lendingRateType: 'FIXED', rate: rate(r), ...(noComp ? {} : { comparisonRate: rate(Math.max(r, v) + 0.12) }), additionalValue: `P${term}Y`, loanPurpose: purpose, repaymentType: repay, tiers: [lvrTier(0, 80)] });
      }
    }
  }
  return {
    productId: `${b.slug}-${id}`,
    productCategory: 'RESIDENTIAL_MORTGAGES',
    name,
    description: `${name} from ${b.name}.`,
    brand: b.name,
    lastUpdated: '2026-10-01T00:00:00Z',
    isTailored: false,
    applicationUri: `https://example.com/${b.slug}/${id}`,
    additionalInformation: { overviewUri: `https://example.com/${b.slug}/${id}` },
    features: [{ featureType: 'REDRAW' }, ...(offset ? [{ featureType: 'OFFSET' }] : []), { featureType: 'EXTRA_REPAYMENTS' }],
    fees: [{ name: 'Application fee', feeType: 'UPFRONT', amount: '600.00' }, ...(annual ? [{ name: 'Package fee', feeType: 'PERIODIC', amount: annual.toFixed(2), additionalValue: 'P1Y' }] : [])],
    eligibility: [{ eligibilityType: 'MIN_AGE', additionalValue: '18' }, { eligibilityType: 'RESIDENCY_STATUS', additionalInfo: 'Australian citizens and permanent residents' }],
    constraints: [{ constraintType: 'MIN_LIMIT', additionalValue: '50000.00' }],
    lendingRates,
  };
}

function termDeposit(b, { rates: tdRates, scale }) {
  return {
    productId: `${b.slug}-td`,
    productCategory: 'TERM_DEPOSITS',
    name: `${b.short} Term Deposit`,
    description: 'Fixed-rate term deposit, interest paid at maturity.',
    lastUpdated: '2026-10-15T00:00:00Z',
    isTailored: false,
    applicationUri: `https://example.com/${b.slug}/td`,
    features: [],
    fees: [],
    eligibility: [],
    constraints: [{ constraintType: 'MIN_BALANCE', additionalValue: '5000.00' }],
    depositRates: Object.entries(tdRates).map(([m, r]) => ({ depositRateType: 'FIXED', rate: scale ? r.toFixed(2) : d(r), additionalValue: `P${m}M`, applicationFrequency: `P${m}M`, tiers: [balTier(5000, 2000000)] })),
  };
}

function savings(b, { base, bonus, bonusInfo, intro }) {
  return {
    productId: `${b.slug}-sav`,
    productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
    name: `${b.short} Saver`,
    description: 'Online savings account.',
    lastUpdated: '2026-09-20T00:00:00Z',
    isTailored: false,
    applicationUri: `https://example.com/${b.slug}/saver`,
    features: [{ featureType: 'UNLIMITED_TXNS' }],
    fees: [],
    eligibility: [],
    constraints: [],
    depositRates: [
      { depositRateType: 'VARIABLE', rate: d(base), tiers: [balTier(0)] },
      ...(bonus ? [{ depositRateType: 'BONUS', rate: d(bonus), additionalValue: bonusInfo, tiers: [balTier(0, 250000)] }] : []),
      ...(intro ? [{ depositRateType: 'INTRODUCTORY', rate: d(intro), additionalValue: 'P4M' }] : []),
    ],
  };
}

function txn(b, monthly) {
  return {
    productId: `${b.slug}-txn`,
    productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
    name: `${b.short} Everyday Account`,
    lastUpdated: '2026-08-01T00:00:00Z',
    isTailored: false,
    applicationUri: `https://example.com/${b.slug}/everyday`,
    features: [{ featureType: 'DIGITAL_WALLET' }, { featureType: 'UNLIMITED_TXNS' }],
    fees: monthly ? [{ name: 'Monthly account fee', feeType: 'PERIODIC', amount: monthly.toFixed(2), additionalValue: 'P1M', additionalInfo: 'Waived if you deposit $2,000 per month' }] : [],
    eligibility: [],
    constraints: [],
    depositRates: [{ depositRateType: 'VARIABLE', rate: '0.0000' }],
  };
}

function card(b, { id, name, purchase, cash, fee }) {
  return {
    productId: `${b.slug}-${id}`,
    productCategory: 'CRED_AND_CHRG_CARDS',
    name,
    lastUpdated: '2026-07-01T00:00:00Z',
    isTailored: false,
    applicationUri: `https://example.com/${b.slug}/${id}`,
    features: [{ featureType: 'INTEREST_FREE', additionalValue: 'P55D' }],
    fees: fee ? [{ name: 'Annual fee', feeType: 'PERIODIC', amount: fee.toFixed(2), additionalValue: 'P1Y' }] : [],
    eligibility: [{ eligibilityType: 'MIN_INCOME', additionalValue: '25000' }],
    constraints: [{ constraintType: 'MIN_LIMIT', additionalValue: '1000.00' }],
    lendingRates: [{ lendingRateType: 'PURCHASE', rate: d(purchase) }, { lendingRateType: 'CASH_ADVANCE', rate: d(cash) }],
  };
}

function personal(b, { fixed, variable }) {
  return {
    productId: `${b.slug}-pl`,
    productCategory: 'PERS_LOANS',
    name: `${b.short} Personal Loan`,
    lastUpdated: '2026-06-01T00:00:00Z',
    isTailored: true,
    applicationUri: `https://example.com/${b.slug}/pl`,
    features: [],
    fees: [{ name: 'Establishment fee', feeType: 'UPFRONT', amount: '250.00' }],
    eligibility: [],
    constraints: [],
    lendingRates: [
      { lendingRateType: 'FIXED', rate: d(fixed), comparisonRate: d(fixed + 0.6), additionalValue: 'P5Y' },
      ...(variable ? [{ lendingRateType: 'VARIABLE', rate: d(variable), comparisonRate: d(variable + 0.6) }] : []),
    ],
  };
}

// Convert a product to the v7 detail shape. With `flaws`, add the kind of mistakes real holders make.
function toV7(p, flaws = false) {
  const q = structuredClone(p);
  q.lendingRates = (q.lendingRates || []).map((r, i) => ({ ...r, applicationType: flaws && i === 0 ? undefined : 'PERIODIC' }));
  q.depositRates = (q.depositRates || []).map((r) => ({ ...r, applicationType: 'PERIODIC' }));
  const strTiers = (r) => ({ ...r, tiers: r.tiers?.map((t) => ({ ...t, minimumValue: String(t.minimumValue), ...(t.maximumValue !== undefined ? { maximumValue: String(t.maximumValue) } : {}) })) });
  q.lendingRates = q.lendingRates.map(strTiers);
  q.depositRates = q.depositRates.map(strTiers);
  q.brand ??= 'Strict Version Bank';
  q.description ??= q.name;
  q.fees = (q.fees || []).map(({ amount, ...f }) => ({ ...f, feeMethodUType: 'fixedAmount', fixedAmount: { amount: flaws && f.feeType === 'PERIODIC' ? '$' + amount : amount } }));
  if (flaws) {
    q.lendingRates[2].comparisonRate = (Number(q.lendingRates[2].comparisonRate) * 100).toFixed(2) + '%';
    q.constraints = [{ constraintType: 'MAX_LVR', additionalValue: '80' }];
    q.lastUpdated = '2026-10-01';
  }
  return q;
}

const s = SHIFT ? 0.15 : 0;
const BRANDS = [
  { slug: 'southern-cross', name: 'Southern Cross Bank (sample)', short: 'SCB', build: (b) => [
    mortgage(b, { id: 'basic', name: 'Basic Home Loan', ooVar: 6.09 + s, invVar: 6.39, fixed: { 1: 5.89, 2: 5.79, 3: 5.84, 5: 6.19 } }),
    mortgage(b, { id: 'package', name: 'Wealth Package Home Loan', ooVar: 6.24, invVar: 6.49, offset: true, annual: 395, fixed: { 2: 5.69 } }),
    termDeposit(b, { rates: { 3: 3.9, 6: 4.2, 12: 4.0, 24: 3.85, 36: 3.8, 60: 3.75 } }),
    savings(b, { base: 1.6, bonus: 3.4, bonusInfo: 'Deposit $1,000+ and make no withdrawals in the month' }),
    txn(b, 5), card(b, { id: 'low', name: 'Low Rate Card', purchase: 12.99, cash: 21.99, fee: 59 }), card(b, { id: 'rewards', name: 'Rewards Platinum', purchase: 20.99, cash: 21.99, fee: 249 }),
    personal(b, { fixed: 9.99, variable: 10.49 }),
    // Problem cases seen in real data
    { ...mortgage(b, { id: 'feeassist', name: 'Fee Assistance Loan - Sub', ooVar: 0, invVar: 0, lvrSteps: [0, 0, 0], ioLoad: 0 }), fees: [] },
    mortgage(b, { id: 'green', name: 'Green Home Loan Investment', ooVar: 2.79, invVar: 2.79, lvrSteps: [0, 0, 0] }),
    { ...termDeposit(b, { rates: { 12: 5.7, 6: 5.5 } }), productId: 'southern-cross-biz-td', name: 'SCB 12 Month Business Term Deposit' },
  ] },
  { slug: 'harbour-mutual', name: 'Harbour Mutual (sample)', short: 'Harbour', build: (b) => [
    mortgage(b, { id: 'value', name: 'Value Variable', ooVar: 5.89, invVar: 6.49, lvrSteps: [0, 0.15, 0.6], fixed: { 1: 5.99, 2: 5.89, 3: 5.99 } }),
    mortgage(b, { id: 'offset', name: 'Offset Home Loan', ooVar: 6.04, invVar: 6.59, offset: true }),
    termDeposit(b, { rates: { 3: 4.05, 6: 4.3, 12: 4.15, 24: 3.9, 36: 3.85 } }),
    savings(b, { base: 4.1 }),
    txn(b, 0), card(b, { id: 'nofee', name: 'No Annual Fee Card', purchase: 13.99, cash: 21.49, fee: 0 }),
    personal(b, { fixed: 8.79 }),
  ] },
  { slug: 'yarra-community', name: 'Yarra Community Bank (sample)', short: 'Yarra', build: (b) => [
    mortgage(b, { id: 'smart', name: 'Smart Home Loan', ooVar: 6.04, invVar: 6.14, ioLoad: 0.3, lvrSteps: [0, 0.05, 0.25], offset: true, fixed: { 1: 5.95, 2: 5.85, 3: 5.79, 5: 6.05 }, invFixedLoad: 0.1 }),
    termDeposit(b, { rates: { 3: 3.8, 6: 4.1, 12: 4.25, 24: 4.0, 36: 3.95, 60: 3.9 } }),
    savings(b, { base: 0.5, bonus: 4.65, bonusInfo: 'Grow your balance each month and make 5 card purchases from linked account', intro: 5.5 }),
    txn(b, 0), card(b, { id: 'low', name: 'Community Low Rate', purchase: 11.99, cash: 19.99, fee: 45 }),
    personal(b, { fixed: 9.49, variable: 9.29 }),
  ] },
  { slug: 'outback-digital', name: 'Outback Digital Bank (sample)', short: 'Outback', build: (b) => [
    mortgage(b, { id: 'straight', name: 'Straight Up Home Loan', ooVar: 5.94, invVar: 6.29, lvrSteps: [-0.1, 0.05, 0.3], fixed: { 1: 5.79, 2: 5.74 } }),
    termDeposit(b, { rates: { 3: 4.35, 6: 4.45, 12: 4.2, 24: 3.95 } }),
    savings(b, { base: 2.0, bonus: 3.0, bonusInfo: 'Deposit $500 and make 3 card purchases each month' }),
    txn(b, 0), card(b, { id: 'card', name: 'Outback Card', purchase: 14.99, cash: 14.99, fee: 0 }),
  ] },
  { slug: 'coral-coast', name: 'Coral Coast Credit Union (sample)', short: 'Coral', build: (b) => [
    mortgage(b, { id: 'basic', name: 'Basic Variable', ooVar: 6.19, invVar: 6.34, scale: true, noComp: true, fixed: { 3: 5.89 } }),
    termDeposit(b, { rates: { 6: 4.0, 12: 4.1 } }),
    { productId: 'coral-coast-legacy', productCategory: 'RESIDENTIAL_MORTGAGES', name: 'Legacy Home Loan', lastUpdated: '2023-02-01T00:00:00Z', isTailored: false, features: [], fees: [], lendingRates: [] },
  ] },
  // Strict holder: rejects x-min-v ranges and anything but one exact version (like some real holders)
  { slug: 'strict-bank', name: 'Strict Version Bank (sample)', short: 'Strict', strict: { list: '5', detail: '7' }, build: (b) => [
    toV7(mortgage(b, { id: 'basic', name: 'Strict Variable', ooVar: 6.0, invVar: 6.3, annual: 300 }), true),
    toV7(savings(b, { base: 4.0 })),
  ] },
  { slug: 'broken-bank', name: 'Broken Bank Ltd (sample)', short: 'Broken', broken: true, build: () => [] },
];

const register = BRANDS.map((b, i) => ({
  dataHolderBrandId: `00000000-0000-4000-8000-00000000000${i + 1}`,
  brandName: b.name,
  publicBaseUri: `${base}/${b.slug}`,
  logoUri: `https://example.com/${b.slug}/logo.png`,
  industries: ['banking'],
  lastUpdated: '2026-10-01T00:00:00Z',
  abn: null,
}));

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

// ---------- Fake bank websites and PDFs, with deliberate problems for the web checks
const site = (b, path) => `${base}/site/${b.slug}${path}`;
const LINK_OVERRIDES = {
  'harbour-mutual-offset': '/p/missing', // broken link
  'harbour-mutual-td': '/blocked/td', // bot protection
  'yarra-community-smart': '/old/smart', // redirects to the homepage
  'outback-digital-td': '/private/td', // excluded by robots.txt
  'yarra-community-sav': '/js/saver', // only renders with JavaScript
};
function withLinks(b, p) {
  if (p.productId === 'coral-coast-legacy') return p;
  return {
    ...p,
    applicationUri: site(b, `/apply/${p.productId}`),
    additionalInformation: { overviewUri: site(b, LINK_OVERRIDES[p.productId] || `/p/${p.productId}`), feesAndPricingUri: site(b, '/schedule.pdf') },
  };
}
// What the bank's own website says. Southern Cross deliberately shows two figures that differ from its CDR data.
function websiteLines(b, p) {
  const out = [p.name];
  const asPct = (v) => (Number(String(v).replace('%', '')) > 1 ? Number(String(v).replace('%', '')) : Number(v) * 100);
  let firstVar = true;
  for (const r of p.lendingRates || []) {
    let v = asPct(r.rate);
    if (p.productId === 'southern-cross-basic' && r.lendingRateType === 'FIXED' && r.additionalValue === 'P1Y' && r.loanPurpose === 'OWNER_OCCUPIED' && r.repaymentType === 'PRINCIPAL_AND_INTEREST') v += 0.05;
    out.push(`${r.lendingRateType.toLowerCase()} ${r.loanPurpose || ''} ${r.repaymentType || ''} ${r.additionalValue || ''}: ${v.toFixed(2)}% p.a.${r.comparisonRate ? ` comparison rate ${asPct(r.comparisonRate).toFixed(2)}% p.a.` : ''}`);
  }
  for (const r of p.depositRates || []) out.push(`${r.depositRateType.toLowerCase()} ${r.additionalValue || ''}: ${asPct(r.rate).toFixed(2)}% p.a.`);
  for (const f of p.fees || []) {
    let a = Number(String(f.amount ?? f.fixedAmount?.amount ?? '0').replace('$', ''));
    if (p.productId === 'southern-cross-package' && f.feeType === 'PERIODIC') a = 350;
    out.push(`${f.name}: $${a.toFixed(2)}`);
  }
  return out;
}
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const page = (title, body) => `<!doctype html><html><head><title>${esc(title)}</title></head><body><nav><a href="/">Home</a></nav><main>${body}</main><footer>Sample bank website for testing. This page has enough ordinary words to look like a real product page, with headings, features and conditions described in full sentences.</footer></body></html>`;
// Minimal valid PDF with one text line per row
function makePdf(lines) {
  const content = ['BT', '/F1 10 Tf', '14 TL', '40 800 Td', ...lines.map((l) => `(${String(l).replace(/[()\\]/g, '\\$&')}) Tj T*`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
function serveSite(u, res) {
  const html = (status, body, extra = {}) => (res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extra }), res.end(body));
  if (u.pathname === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }), res.end('User-agent: *\nDisallow: /site/outback-digital/private/\n');
  if (u.pathname === '/') return html(200, page('Sample bank home', '<h1>Welcome</h1><p>Choose a product.</p>'));
  const m = u.pathname.match(/^\/site\/([^/]+)(\/.*)?$/);
  const b = m && BRANDS.find((x) => x.slug === m[1]);
  if (!b) return html(404, page('Not found', '<h1>Page not found</h1>'));
  const rest = m[2] || '/';
  const all = b.build(b);
  if (rest === '/schedule.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    return res.end(makePdf([`${b.name} interest rates and fees`, ...all.flatMap((p) => websiteLines(b, p))]));
  }
  if (rest.startsWith('/old/')) return res.writeHead(301, { location: '/' }), res.end();
  if (rest.startsWith('/blocked/')) return html(403, '<html><body><h1>Access Denied</h1>You don\'t have permission to access this server.</body></html>');
  if (rest.startsWith('/apply/')) return html(200, page('Apply', '<h1>Apply online</h1><p>Start your application.</p>'));
  const id = rest.startsWith('/js/') ? 'yarra-community-sav' : rest.startsWith('/private/') ? 'outback-digital-td' : decodeURIComponent(rest.replace(/^\/p\//, ''));
  const p = all.find((x) => x.productId === id);
  if (!p) return html(404, page('Not found', '<h1>Page not found</h1>'));
  const lines = websiteLines(b, p);
  const body = `<h1>${esc(p.name)}</h1><ul>${lines.slice(1).map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p><a href="${site(b, '/schedule.pdf')}">Interest rates and fees schedule (PDF)</a> <a href="${site(b, '/terms')}">Terms and conditions</a></p>`;
  if (rest.startsWith('/js/'))
    return html(200, `<!doctype html><html><head><title>${esc(p.name)}</title></head><body><div id="app"></div><script>document.getElementById('app').innerHTML = ${JSON.stringify(body)};</script></body></html>`);
  return html(200, page(p.name, body));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname === '/' || u.pathname === '/robots.txt' || u.pathname.startsWith('/site/')) return serveSite(u, res);
    const xv = req.headers['x-v'];
    if (!xv) return send(res, 400, { errors: [{ code: 'urn:au-cds:error:cds-all:Header/Missing', title: 'Missing Required Header', detail: 'x-v' }] });
    if (u.pathname === '/cdr-register/v1/banking/data-holders/brands/summary')
      return send(res, 200, { data: register, links: { self: u.href }, meta: {} }, { 'x-v': '1' });

    const m = u.pathname.match(/^\/([^/]+)\/cds-au\/v1\/banking\/products(?:\/([^/]+))?$/);
    const b = m && BRANDS.find((x) => x.slug === m[1]);
    if (!b) return send(res, 404, { errors: [{ code: 'urn:au-cds:error:cds-all:Resource/NotFound' }] });
    if (b.broken) return send(res, 503, { errors: [{ code: 'urn:au-cds:error:cds-all:Service/Unavailable' }] });
    if (b.strict) {
      const want = m[2] ? b.strict.detail : b.strict.list;
      const xmin = req.headers['x-min-v'];
      if (xv !== want || (xmin && xmin !== want))
        return send(res, 406, { errors: [{ code: 'urn:au-cds:error:cds-all:Header/UnsupportedVersion', title: 'Unsupported Version', detail: `Requested version not supported` }] });
    }
    const all = b.build(b).map((p) => withLinks(b, p));
    if (m[2]) {
      const p = all.find((x) => x.productId === decodeURIComponent(m[2]));
      return p ? send(res, 200, { data: p, links: { self: u.href }, meta: {} }, { 'x-v': b.strict ? b.strict.detail : '4' }) : send(res, 404, { errors: [] });
    }
    // List: summary fields only, paginated 3 per page to exercise paging
    const size = 3;
    const page = Number(u.searchParams.get('page') || 1);
    const items = all.slice((page - 1) * size, page * size).map(({ lendingRates, depositRates, fees, features, eligibility, constraints, ...summary }) => summary);
    const totalPages = Math.max(1, Math.ceil(all.length / size));
    const next = page < totalPages ? `${base}/${b.slug}/cds-au/v1/banking/products?page=${page + 1}` : undefined;
    send(res, 200, { data: { products: items }, links: { self: u.href, ...(next ? { next } : {}) }, meta: { totalRecords: all.length, totalPages } }, { 'x-v': '3' });
  })
  .listen(PORT, () => console.log(`Mock CDR APIs on ${base} (shift=${SHIFT})`));
