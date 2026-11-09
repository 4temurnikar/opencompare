// Energy rankings and plain-English insights, using the same cost model as the website.
import { annualCost, bestFit, DEFAULTS } from '../../site/energy-cost.js';
import { networkStates } from './normalise.mjs';

const STATE_NAME = { NSW: 'NSW', VIC: 'Victoria', QLD: 'Queensland', SA: 'South Australia', ACT: 'the ACT', TAS: 'Tasmania', WA: 'WA', NT: 'the NT' };
const $ = (n) => `$${Math.round(n).toLocaleString('en-AU')}`;
const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const residential = (p) => p.cu !== 'BUSINESS';
const hasFuel = (p, fuel) => (fuel === 'E' ? ['ELECTRICITY', 'DUAL'] : ['GAS', 'DUAL']).includes(p.f) && (fuel === 'E' ? p.e : p.g)?.tp?.length;
// A plan named as a demand tariff whose demand charges aren't published would look far cheaper than it is
export const namedDemand = (p) => /\bdemand\b/i.test(p.n || '');
export const isDemand = (p, fuel) => (fuel === 'E' ? p.e : p.g)?.tp?.some((t) => t.kind === 'demand') || (fuel === 'E' && namedDemand(p));
const usable = (p, fuel) => p.detail && !p.bad && residential(p) && hasFuel(p, fuel) && !isDemand(p, fuel);
// Plans open only to particular groups shouldn't headline a ranking
const RESTRICTED = new Set(['SENIOR_CARD', 'SPORT_CLUB_MEMBER', 'ORG_MEMBER', 'LOYALTY_MEMBER', 'GROUP_BUY_MEMBER', 'THIRD_PARTY_ONLY', 'REQ_EQUIP_SUPPLIER', 'CONTINGENT_PLAN', 'EXISTING_BATTERY', 'EXISTING_POOL', 'SPECIFIC_LOCATION']);
const open = (p, fuel) => !((fuel === 'E' ? p.e : p.g).elig || []).some((e) => RESTRICTED.has(e.type));

/** Typical annual cost for each plan (stored so the next run can detect price changes) */
export function typicalCosts(plans) {
  for (const p of plans) {
    p.tc = {};
    for (const fuel of ['E', 'G']) if (p.detail && hasFuel(p, fuel)) p.tc[fuel] = annualCost(p, fuel, { usage: DEFAULTS[fuel].usage })?.total ?? null;
  }
}

// Where one network serves most households in a state, headline it even if others list more plans
const PREFERRED = { E: { NSW: /^ausgrid$/i }, G: { NSW: /jemena/i } };
/**
 * The network each state's headline board is ranked on: a network that belongs to that state (plans
 * near borders list networks from the neighbouring state too), the preferred one where set, otherwise
 * the one with the most residential market plans.
 */
export function mainNetworks(plans, fuel) {
  const count = new Map();
  for (const p of plans) {
    if (!usable(p, fuel) || p.t !== 'MARKET') continue;
    for (const s of p.st)
      for (const d of p.d) {
        if (!networkStates(d).includes(s)) continue;
        const k = `${s}|${d}`;
        count.set(k, (count.get(k) || 0) + 1);
      }
  }
  const byState = new Map();
  for (const [k, n] of count) {
    const [s, d] = k.split('|');
    (byState.get(s) || byState.set(s, []).get(s)).push({ state: s, network: d, n });
  }
  const best = new Map();
  for (const [s, list] of byState) {
    const pref = PREFERRED[fuel]?.[s];
    const pool = pref && list.some((x) => pref.test(x.network)) ? list.filter((x) => pref.test(x.network)) : list;
    best.set(s, pool.sort((a, b) => b.n - a.n || a.network.localeCompare(b.network))[0]);
  }
  return [...best.values()].sort((a, b) => b.n - a.n);
}

function rankNetwork(plans, fuel, state, network) {
  const rows = [];
  for (const p of plans) {
    if (!usable(p, fuel) || !p.st.includes(state) || !p.d.includes(network)) continue;
    const cost = p.tc?.[fuel];
    if (!Number.isFinite(cost)) continue;
    rows.push({ id: p.id, retailer: p.r, plan: p.n, type: p.t, cost, open: open(p, fuel), fixed: (fuel === 'E' ? p.e : p.g).fx, tou: (fuel === 'E' ? p.e : p.g).tp.some((t) => t.kind === 'tou') });
  }
  return rows.sort((a, b) => a.cost - b.cost);
}

export function buildEnergyInsights(plans) {
  const boards = [];
  const insights = [];
  for (const fuel of ['E', 'G']) {
    const unit = DEFAULTS[fuel].unit;
    const usage = DEFAULTS[fuel].usage.toLocaleString('en-AU');
    const fuelName = fuel === 'E' ? 'electricity' : 'gas';
    for (const { state, network } of mainNetworks(plans, fuel)) {
      const all = rankNetwork(plans, fuel, state, network);
      // A typical bill under half the network's median isn't a believable headline (e.g. an export-only
      // plan with no charges at all): keep such plans out of rankings and say so
      const mid = median(all.filter((r) => r.type === 'MARKET').map((r) => r.cost));
      const held = all.filter((r) => mid && r.cost < mid * 0.5);
      const rows = all.filter((r) => !held.includes(r));
      const market = rows.filter((r) => r.type === 'MARKET' && r.open);
      const standing = rows.filter((r) => r.type === 'STANDING' || r.type === 'REGULATED');
      // Each retailer's cheapest open market plan
      const perRetailer = [];
      const seenR = new Set();
      for (const r of market) if (!seenR.has(r.retailer)) seenR.add(r.retailer), perRetailer.push(r);
      const b = { id: `${fuel}-${state}`, fuel, state, network, usage: DEFAULTS[fuel].usage, unit, n: perRetailer.length, median: median(market.map((r) => r.cost)), ranking: perRetailer.slice(0, 40), heldBack: held.map((r) => ({ id: r.id, retailer: r.retailer, plan: r.plan, cost: r.cost, why: 'typical bill under half the network median' })) };
      boards.push(b);
      if (perRetailer.length >= 2) {
        const [top, second] = perRetailer;
        insights.push({
          id: `cheapest-${fuel}-${state}`,
          group: fuel === 'E' ? 'Electricity' : 'Gas',
          headline: `${top.retailer} has the cheapest ${fuelName} plan in ${STATE_NAME[state] || state}: about ${$(top.cost)} a year`,
          detail: `${top.plan} on the ${network} network, for ${usage} ${unit} a year including GST. That's ${$(b.median - top.cost)} less than the typical market plan (${$(b.median)}). Next cheapest: ${second.retailer} at ${$(second.cost)}.`,
          board: b.id,
        });
      }
      if (standing.length && market.length) {
        const gap = median(standing.map((r) => r.cost)) - market[0].cost;
        if (gap > 30)
          insights.push({
            id: `standing-${fuel}-${state}`,
            group: fuel === 'E' ? 'Electricity' : 'Gas',
            headline: `Moving off a standing offer could save up to ${$(gap)} a year on ${fuelName} in ${STATE_NAME[state] || state}`,
            detail: `Typical standing offer on ${network}: ${$(median(standing.map((r) => r.cost)))} a year. Cheapest open market plan: ${market[0].retailer} ${market[0].plan} at ${$(market[0].cost)}. Based on ${usage} ${unit} a year.`,
            board: b.id,
          });
      }
    }
  }
  // Best solar feed-in by state (retailer-paid, residential electricity)
  const fitByState = new Map();
  for (const p of plans) {
    if (!usable(p, 'E')) continue;
    const v = bestFit(p.e);
    if (v === null) continue;
    for (const s of p.st) if (!fitByState.has(s) || v > fitByState.get(s).v) fitByState.set(s, { v, p });
  }
  const fits = [...fitByState.entries()].sort((a, b) => b[1].v - a[1].v);
  if (fits.length) {
    const [s, { v, p }] = fits[0];
    insights.push({
      id: 'fit-best',
      group: 'Solar',
      headline: `Highest solar feed-in tariff: ${p.r}, ${(v * 100).toFixed(1)}c per kWh in ${STATE_NAME[s] || s}`,
      detail: `${p.n}. Best by state: ${fits.map(([st, x]) => `${st} ${(x.v * 100).toFixed(1)}c (${x.p.r})`).join(', ')}. A high feed-in rate can come with higher usage prices, so compare the total with your own export.`,
    });
  }
  // Fixed-price plans
  const res = plans.filter((p) => usable(p, 'E') && p.t === 'MARKET');
  const fixed = res.filter((p) => p.e.fx === true);
  if (res.length >= 10)
    insights.push({
      id: 'fixed-share',
      group: 'Electricity',
      headline: `${Math.round((fixed.length / res.length) * 100)}% of residential electricity market plans fix their prices`,
      detail: `${fixed.length.toLocaleString('en-AU')} of ${res.length.toLocaleString('en-AU')} plans. Fixed prices protect you from rises during the term; variable plans can change with notice.`,
    });
  return { boards, insights };
}

/** Compare each plan's typical cost with the previous run */
export function diffPlans(prev, plans) {
  const before = new Map((prev || []).map((p) => [p.id, p.tc || {}]));
  const out = [];
  for (const p of plans) {
    const was = before.get(p.id);
    if (!was) continue;
    for (const fuel of ['E', 'G']) {
      const a = was[fuel];
      const b = p.tc?.[fuel];
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= 1) out.push({ id: p.id, retailer: p.r, plan: p.n, fuel, states: p.st, from: a, to: b, delta: b - a });
    }
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
