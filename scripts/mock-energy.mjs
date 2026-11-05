#!/usr/bin/env node
// Local mock of the AER-hosted energy plan APIs, with FICTIONAL retailers, plus plan fact sheets.
// Covers single-rate, time-of-use, controlled load, demand, gas stepped rates, solar feed-in,
// discounts, a standing offer, a restricted plan, and deliberate data-quality problems.
// Run: npm run mock:energy   then   npm run refresh:energy:mock
// MOCK_SHIFT=1 raises some prices to test change detection.
import http from 'node:http';

const PORT = Number(process.env.MOCK_ENERGY_PORT || 8788);
const SHIFT = Number(process.env.MOCK_SHIFT || 0);
const base = `http://localhost:${PORT}`;
const $ = (v) => v.toFixed(4); // dollars excl. GST as AmountString

const NSW = { includedPostcodes: ['2000-2234'], distributors: ['Ausgrid'] };
const NSWG = { includedPostcodes: ['2000-2234'], distributors: ['Jemena Gas Networks'] };
const VIC = { includedPostcodes: ['3000-3207'], distributors: ['CitiPower'] };
const VICG = { includedPostcodes: ['3000-3207'], distributors: ['Multinet'] };
const QLD = { includedPostcodes: ['4000-4299'], distributors: ['Energex'] };
const ALLDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

const single = (supply, rate, extra = {}) => ({ displayName: 'All year', startDate: '01-01', endDate: '12-31', dailySupplyChargeType: 'SINGLE', dailySupplyCharge: $(supply), rateBlockUType: 'singleRate', singleRate: { displayName: 'Anytime', rates: [{ unitPrice: $(rate), measureUnit: 'KWH' }] }, ...extra });
const tou = (supply, peak, shoulder, off) => ({
  displayName: 'All year',
  startDate: '01-01',
  endDate: '12-31',
  dailySupplyChargeType: 'SINGLE',
  dailySupplyCharge: $(supply),
  rateBlockUType: 'timeOfUseRates',
  timeOfUseRates: [
    { displayName: 'Peak', type: 'PEAK', rates: [{ unitPrice: $(peak), measureUnit: 'KWH' }], timeOfUse: [{ days: WEEK, startTime: '14:00', endTime: '20:00' }] },
    { displayName: 'Shoulder', type: 'SHOULDER', rates: [{ unitPrice: $(shoulder), measureUnit: 'KWH' }], timeOfUse: [{ days: WEEK, startTime: '07:00', endTime: '14:00' }, { days: WEEK, startTime: '20:00', endTime: '22:00' }, { days: ['SAT', 'SUN'], startTime: '07:00', endTime: '22:00' }] },
    { displayName: 'Off peak', type: 'OFF_PEAK', rates: [{ unitPrice: $(off), measureUnit: 'KWH' }], timeOfUse: [{ days: ALLDAYS, startTime: '22:00', endTime: '07:00' }] },
  ],
});
const fit = (c) => [{ displayName: 'Solar feed-in', scheme: 'CURRENT', payerType: 'RETAILER', tariffUType: 'singleTariff', singleTariff: { rates: [{ unitPrice: $(c / 100), measureUnit: 'KWH' }] } }];
const contract = (tariffs, extra = {}) => ({ pricingModel: 'SINGLE_RATE', isFixed: false, variation: 'Prices may change with 5 business days notice.', paymentOption: ['DIRECT_DEBIT', 'BPAY'], coolingOffDays: 10, billFrequency: ['P3M'], termType: 'ONGOING', tariffPeriod: tariffs, ...extra });

function plans() {
  const s = SHIFT ? 0.02 : 0;
  return {
    sparky: [
      { planId: 'SPK-NSW-1', displayName: 'Sparky Saver', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([single(1.05, 0.29 + s)], { solarFeedInTariff: fit(5), discounts: [{ displayName: 'Pay on time', type: 'CONDITIONAL', category: 'PAY_ON_TIME', methodUType: 'percentOfUse', percentOfUse: { rate: '0.05' } }] }) },
      { planId: 'SPK-NSW-TOU', displayName: 'Sparky Smart Time', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([tou(1.1, 0.48, 0.30, 0.19)], { pricingModel: 'TIME_OF_USE', timeZone: 'LOCAL', meterTypes: ['SMART'], solarFeedInTariff: fit(4) }) },
      { planId: 'SPK-NSW-STD', displayName: 'Sparky Standing Offer', type: 'STANDING', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([single(1.25, 0.36)]) },
      { planId: 'SPK-VIC-1', displayName: 'Sparky Saver Vic', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: VIC, electricityContract: contract([single(1.0, 0.27)], { solarFeedInTariff: fit(4.9) }) },
      { planId: 'SPK-QLD-1', displayName: 'Sparky Saver Qld', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: QLD, electricityContract: contract([single(1.15, 0.26)], { solarFeedInTariff: fit(8) }) },
      { planId: 'SPK-NSW-GAS', displayName: 'Sparky Gas', type: 'MARKET', fuelType: 'GAS', customerType: 'RESIDENTIAL', geography: NSWG, gasContract: contract([{ displayName: 'All year', startDate: '01-01', endDate: '12-31', dailySupplyChargeType: 'SINGLE', dailySupplyCharge: $(0.75), rateBlockUType: 'singleRate', singleRate: { displayName: 'Usage', period: 'P1D', rates: [{ unitPrice: $(0.042), volume: 50 }, { unitPrice: $(0.031) }] } }]) },
    ],
    gumtree: [
      { planId: 'GUM-NSW-1', displayName: 'Gumtree Simple', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([single(0.98, 0.275)], { isFixed: true, termType: '1_YEAR', variation: undefined, solarFeedInTariff: fit(6) }) },
      { planId: 'GUM-NSW-SENIOR', displayName: 'Gumtree Seniors', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([single(0.8, 0.22)], { eligibility: [{ type: 'SENIOR_CARD', information: 'Seniors card holders only' }] }) },
      { planId: 'GUM-NSW-CL', displayName: 'Gumtree Hot Water', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([single(1.02, 0.285)], { pricingModel: 'SINGLE_RATE_CONT_LOAD', controlledLoad: [{ displayName: 'Controlled load 1', rateBlockUType: 'singleRate', singleRate: { displayName: 'CL1', rates: [{ unitPrice: $(0.15) }], dailySupplyCharge: $(0.05) } }] }) },
      { planId: 'GUM-NSW-DEM', displayName: 'Gumtree Demand', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([single(1.0, 0.21), { displayName: 'Demand', type: 'NETWORK', startDate: '01-01', endDate: '12-31', rateBlockUType: 'demandCharges', demandCharges: [{ displayName: 'Peak demand', amount: '0.30', startTime: '16:00', endTime: '20:00', measurementPeriod: 'MONTH', chargePeriod: 'MONTH' }] }]) },
      // Deliberate problems: price in cents, missing cooling-off days, conditional discount without category, variable without variation text
      { planId: 'GUM-NSW-BAD', displayName: 'Gumtree Flex', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: NSW, electricityContract: contract([single(1.0, 28.5)], { coolingOffDays: undefined, variation: undefined, discounts: [{ displayName: 'Direct debit', type: 'CONDITIONAL', methodUType: 'percentOfBill', percentOfBill: { rate: '0.03' } }] }) },
      { planId: 'GUM-BIZ', displayName: 'Gumtree Business', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'BUSINESS', geography: NSW, electricityContract: contract([single(1.3, 0.25)]) },
    ],
    hgp: [
      { planId: 'HGP-VIC-1', displayName: 'Harbour Home', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: VIC, electricityContract: contract([single(1.05, 0.255)], { discounts: [{ displayName: 'Always on', type: 'GUARANTEED', category: 'GUARANTEED_DISCOUNT', methodUType: 'percentOfUse', percentOfUse: { rate: '0.03' } }] }) },
      { planId: 'HGP-VIC-STD', displayName: 'Harbour Standing', type: 'STANDING', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: VIC, electricityContract: contract([single(1.2, 0.33)]) },
      { planId: 'HGP-VIC-GAS', displayName: 'Harbour Gas', type: 'MARKET', fuelType: 'GAS', customerType: 'RESIDENTIAL', geography: VICG, gasContract: contract([{ displayName: 'All year', startDate: '01-01', endDate: '12-31', dailySupplyChargeType: 'SINGLE', dailySupplyCharge: $(0.85), rateBlockUType: 'singleRate', singleRate: { displayName: 'Usage', rates: [{ unitPrice: $(0.034) }] } }]) },
    ],
    'locals-a': [{ planId: 'LOC-A-1', displayName: 'Locals Community', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: VIC, electricityContract: contract([single(1.08, 0.262)]) }],
    'locals-b': [{ planId: 'LOC-B-1', displayName: 'Locals Club', type: 'MARKET', fuelType: 'ELECTRICITY', customerType: 'RESIDENTIAL', geography: QLD, electricityContract: contract([single(1.12, 0.268)]) }],
  };
}
const FEEDS = { sparky: ['sparky'], gumtree: ['gumtree'], hgp: ['hgp'], locals: ['locals-a', 'locals-b'] };
const NAMES = { sparky: 'Sparky Energy (sample)', gumtree: 'Gumtree Power (sample)', hgp: 'Harbour Gas & Power (sample)', 'locals-a': 'Locals A (sample)', 'locals-b': 'Locals B (sample)' };

function withMeta(p, brand) {
  const sheet = `${base}/sheets/${brand}/${p.planId}.pdf`;
  return {
    effectiveFrom: '2026-07-01T00:00:00Z',
    lastUpdated: SHIFT && p.planId === 'SPK-NSW-1' ? '2026-11-05T00:00:00Z' : '2026-10-01T00:00:00Z',
    description: `${p.displayName} from ${NAMES[brand]}`,
    brand,
    brandName: NAMES[brand],
    applicationUri: `${base}/apply/${p.planId}`,
    additionalInformation: { overviewUri: p.planId === 'HGP-VIC-1' ? `${base}/missing/${p.planId}` : `${base}/plans/${brand}/${p.planId}`, pricingUri: p.planId === 'LOC-B-1' ? `${base}/blocked/${p.planId}.pdf` : sheet },
    ...p,
  };
}

// ---- fact sheets: prices in cents including GST; one deliberately differs from the CDR data
function factLines(p) {
  const out = [`${p.displayName} - Basic Plan Information Document`];
  for (const [fuel, c] of [['Electricity', p.electricityContract], ['Gas', p.gasContract]]) {
    if (!c) continue;
    for (const t of c.tariffPeriod) {
      if (t.dailySupplyCharge) out.push(`${fuel} daily supply charge: ${(Number(t.dailySupplyCharge) * 110).toFixed(2)} c/day incl. GST`);
      const rates = t.singleRate ? t.singleRate.rates.map((r) => ['Usage', r]) : (t.timeOfUseRates || []).map((r) => [r.displayName, r.rates[0]]);
      for (const [name, r] of rates) {
        let c100 = Number(r.unitPrice) * 110;
        if (p.planId === 'SPK-VIC-1') c100 += 1.5; // fact sheet disagrees with the CDR data
        out.push(`${fuel} ${name}: ${c100.toFixed(2)} c/${fuel === 'Gas' ? 'MJ' : 'kWh'} incl. GST`);
      }
    }
  }
  return out;
}
function makePdf(lines) {
  const content = ['BT', '/F1 10 Tf', '14 TL', '40 800 Td', ...lines.map((l) => `(${String(l).replace(/[()\\]/g, '\\$&')}) Tj T*`), 'ET'].join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(pdf);
}
const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}<p>Sample energy retailer page used for automated testing, with enough ordinary text to look like a real plan page describing the offer, its terms and how to sign up.</p></main></body></html>`;

const send = (res, status, body, headers = {}) => (res.writeHead(status, { 'content-type': 'application/json', ...headers }), res.end(JSON.stringify(body)));
http
  .createServer((req, res) => {
    const u = new URL(req.url, base);
    const all = plans();
    const find = (id) => {
      for (const [b, list] of Object.entries(all)) {
        const p = list.find((x) => x.planId === id);
        if (p) return withMeta(p, b);
      }
      return null;
    };
    if (u.pathname === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }), res.end('User-agent: *\nAllow: /\n');
    let m = u.pathname.match(/^\/sheets\/([^/]+)\/([^/]+)\.pdf$/);
    if (m) {
      const p = find(m[2]);
      if (!p) return res.writeHead(404), res.end();
      return res.writeHead(200, { 'content-type': 'application/pdf' }), res.end(makePdf(factLines(p)));
    }
    if (u.pathname.startsWith('/blocked/')) return res.writeHead(403, { 'content-type': 'text/html' }), res.end('<h1>Access Denied</h1>');
    if (u.pathname.startsWith('/missing/')) return res.writeHead(404, { 'content-type': 'text/html' }), res.end('<h1>Not found</h1>');
    if (u.pathname.startsWith('/apply/') || u.pathname.startsWith('/plans/')) return res.writeHead(200, { 'content-type': 'text/html' }), res.end(page('Plan', '<p>Plan details.</p>'));

    m = u.pathname.match(/^\/eme\/([^/]+)\/cds-au\/v1\/energy\/plans(?:\/([^/]+))?$/);
    if (!m || !FEEDS[m[1]]) return send(res, 404, { errors: [{ code: 'urn:au-cds:error:cds-all:Resource/NotFound' }] });
    if (!req.headers['x-v']) return send(res, 400, { errors: [{ code: 'urn:au-cds:error:cds-all:Header/Missing' }] });
    const brands = FEEDS[m[1]];
    const list = brands.flatMap((b) => all[b].map((p) => withMeta(p, b)));
    if (m[2]) {
      const p = list.find((x) => x.planId === decodeURIComponent(m[2]));
      return p ? send(res, 200, { data: p, links: { self: u.href }, meta: {} }, { 'x-v': m[1] === 'hgp' ? '2' : '3' }) : send(res, 404, { errors: [] });
    }
    const summary = list.map(({ electricityContract, gasContract, meteringCharges, ...rest }) => rest);
    send(res, 200, { data: { plans: summary }, links: { self: u.href }, meta: { totalRecords: summary.length, totalPages: 1 } }, { 'x-v': '1' });
  })
  .listen(PORT, () => console.log(`Mock energy APIs on ${base}/eme (shift=${SHIFT})`));
