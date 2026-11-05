// Turns CDR EnergyPlanDetail payloads into compact records for comparison and cost estimates.
// All prices stay in dollars excluding GST, as published.
import { postcodeState } from '../../site/energy-cost.js';

// Distribution networks → states (used when a plan lists networks but no postcodes)
const NETWORKS = [
  [/ausgrid/i, ['NSW']],
  [/endeavour/i, ['NSW']],
  [/essential/i, ['NSW']],
  [/jemena gas|jgn/i, ['NSW']],
  [/evoenergy|actewagl distribution|icon water/i, ['ACT']],
  [/energex/i, ['QLD']],
  [/ergon/i, ['QLD']],
  [/allgas/i, ['QLD']],
  [/sa power|sapn|etsa/i, ['SA']],
  [/tasnetworks|aurora energy|tas gas|tasgas/i, ['TAS']],
  [/citipower|powercor|united energy|multinet|ausnet/i, ['VIC']],
  [/jemena/i, ['VIC']],
  [/australian gas networks|\bagn\b|envestra/i, ['SA', 'VIC', 'QLD']],
  [/atco|western power|horizon/i, ['WA']],
  [/power and water/i, ['NT']],
];
export function networkStates(name) {
  for (const [re, st] of NETWORKS) if (re.test(name || '')) return st;
  return [];
}

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clip = (s, n = 200) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);
const blocks = (rates) => (rates || []).map((r) => ({ p: num(r.unitPrice), v: num(r.volume), u: r.measureUnit || null })).filter((b) => b.p !== null);
const windows = (tou) => (tou || []).map((w) => ({ days: w.days || [], s: w.startTime, e: w.endTime }));

function tariffPeriod(p) {
  const out = { name: clip(p.displayName, 80), ty: p.type || null, sd: p.startDate, ed: p.endDate, sup: num(p.dailySupplyCharge), kind: null };
  if (p.dailySupplyChargeType === 'BAND' && p.bandedDailySupplyCharges?.length) out.bands = p.bandedDailySupplyCharges.map((b) => ({ p: num(b.unitPrice), v: num(b.volume) })).filter((b) => b.p !== null);
  // Older versions put dailySupplyCharges on the period directly
  if (out.sup === null && p.dailySupplyCharges !== undefined) out.sup = num(p.dailySupplyCharges);
  const t = p.rateBlockUType;
  if (t === 'singleRate' && p.singleRate) {
    out.kind = 'single';
    out.blocks = blocks(p.singleRate.rates);
    out.per = p.singleRate.period || null;
    out.unit = out.blocks[0]?.u || null;
  } else if (t === 'timeOfUseRates' && p.timeOfUseRates?.length) {
    out.kind = 'tou';
    out.tou = p.timeOfUseRates.map((r) => ({ type: r.type, name: clip(r.displayName, 60), blocks: blocks(r.rates), per: r.period || null, win: windows(r.timeOfUse) }));
    out.unit = out.tou[0]?.blocks[0]?.u || null;
  } else if (t === 'demandCharges' && p.demandCharges?.length) {
    out.kind = 'demand';
    out.dem = p.demandCharges.map((d) => ({ name: clip(d.displayName, 60), amt: num(d.amount), unit: d.measureUnit || 'KWH', s: d.startTime, e: d.endTime, days: d.days || [], mp: d.measurementPeriod, cp: d.chargePeriod }));
  }
  return out;
}

function contract(c) {
  if (!c) return null;
  return {
    pm: c.pricingModel || null,
    fx: c.isFixed ?? null,
    term: c.termType || null,
    cool: c.coolingOffDays ?? null,
    bill: c.billFrequency || [],
    meters: c.meterTypes || [],
    pay: c.paymentOption || [],
    var: clip(c.variation, 240),
    onExpiry: clip(c.onExpiryDescription, 240),
    terms: clip(c.terms, 240),
    tp: (c.tariffPeriod || []).map(tariffPeriod),
    cl: (c.controlledLoad || []).map((x) => {
      const o = { name: clip(x.displayName, 80), kind: x.rateBlockUType === 'timeOfUseRates' ? 'tou' : 'single' };
      if (x.singleRate) Object.assign(o, { blocks: blocks(x.singleRate.rates), per: x.singleRate.period || null, sup: num(x.singleRate.dailySupplyCharge) });
      if (x.timeOfUseRates) Object.assign(o, { tou: x.timeOfUseRates.map((r) => ({ type: r.type, blocks: blocks(r.rates), per: r.period || null, win: windows(r.timeOfUse) })), sup: num(x.timeOfUseRates[0]?.dailySupplyCharge) });
      return o;
    }),
    fit: (c.solarFeedInTariff || []).map((f) => ({
      name: clip(f.displayName, 80),
      scheme: f.scheme,
      payer: f.payerType,
      kind: f.tariffUType === 'timeVaryingTariffs' ? 'tv' : 'single',
      blocks: blocks(f.singleTariff?.rates),
      tv: (f.timeVaryingTariffs || []).map((t) => ({ type: t.type || null, blocks: blocks(t.rates), win: windows(t.timeVariations) })),
      sd: f.startDate || null,
      ed: f.endDate || null,
    })),
    disc: (c.discounts || []).map((d) => ({ name: clip(d.displayName, 80), desc: clip(d.description, 160), type: d.type, cat: d.category || null, m: d.methodUType, rate: num(d.percentOfBill?.rate ?? d.percentOfUse?.rate ?? d.percentOverThreshold?.rate), amt: num(d.fixedAmount?.amount), end: d.endDate || null })),
    fees: (c.fees || []).map((f) => ({ type: f.type, term: f.term, amt: num(f.amount), rate: num(f.rate), desc: clip(f.description, 120) })),
    inc: (c.incentives || []).map((i) => ({ name: clip(i.displayName, 80), cat: i.category })),
    elig: (c.eligibility || []).map((e) => ({ type: e.type, info: clip(e.information, 120) })),
    green: c.intrinsicGreenPower?.greenPercentage ? num(c.intrinsicGreenPower.greenPercentage) : null,
    gp: (c.greenPowerCharges || []).length > 0,
  };
}

/** Plan list item (+ detail when available) → compact record */
export function normalisePlan(p, retailerName) {
  const geo = p.geography || {};
  const inc = geo.includedPostcodes || [];
  const states = new Set();
  for (const x of inc) {
    const m = String(x).match(/(\d{3,4})(?:\s*-\s*(\d{3,4}))?/);
    if (!m) continue;
    const a = postcodeState(m[1]);
    const b = postcodeState(m[2] || m[1]);
    if (a) states.add(a);
    if (b) states.add(b);
  }
  if (!states.size) for (const d of geo.distributors || []) networkStates(d).forEach((s) => states.add(s));
  return {
    id: p.planId,
    b: p.brand,
    r: p.brandName || retailerName,
    n: clip(p.displayName, 120) || '(unnamed plan)',
    desc: clip(p.description, 300),
    t: p.type,
    f: p.fuelType,
    cu: p.customerType || null,
    inc,
    exc: geo.excludedPostcodes || [],
    d: geo.distributors || [],
    st: [...states].sort(),
    up: p.lastUpdated,
    ef: p.effectiveFrom || null,
    et: p.effectiveTo || null,
    links: { apply: p.applicationUri || null, overview: p.additionalInformation?.overviewUri || null, pricing: p.additionalInformation?.pricingUri || null, terms: p.additionalInformation?.termsUri || null, eligibility: p.additionalInformation?.eligibilityUri || null },
    meter: (p.meteringCharges || []).map((m) => ({ name: clip(m.displayName, 60), min: num(m.minimumValue), max: num(m.maximumValue), per: m.period || null })),
    e: contract(p.electricityContract),
    g: contract(p.gasContract),
    detail: !p._detailMissing,
  };
}
