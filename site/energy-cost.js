// Annual cost estimates for energy plans. Shared by the website (plan finder) and the daily
// pipeline (rankings and insights), so both always agree.
// Prices in plan records are in dollars EXCLUDING GST, as published under the Consumer Data
// Standards; estimates add GST (10%). Solar feed-in credits are not subject to GST here.

export const GST = 0.1;
export const DEFAULTS = {
  E: { usage: 4000, unit: 'kWh', presets: [['1–2 people', 2800], ['3–4 people', 4000], ['5+ people', 6000]] },
  G: { usage: 20000, unit: 'MJ', presets: [['Small', 10000], ['Medium', 20000], ['Large', 35000]] },
};

// Typical residential electricity use by hour (share of daily use), used to split usage across
// time-of-use windows. A simple, published-style shape: morning and evening peaks.
const WEEKDAY = [2.6, 2.3, 2.2, 2.1, 2.2, 2.8, 4.0, 5.2, 5.0, 4.2, 3.8, 3.7, 3.7, 3.6, 3.7, 4.0, 4.8, 6.2, 7.4, 7.2, 6.4, 5.4, 4.3, 3.2];
const WEEKEND = [2.8, 2.5, 2.3, 2.2, 2.2, 2.4, 3.0, 3.9, 4.6, 4.9, 4.8, 4.6, 4.4, 4.2, 4.1, 4.3, 4.8, 5.9, 6.8, 6.7, 6.0, 5.2, 4.3, 3.3];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const norm = (a) => {
  const t = a.reduce((x, y) => x + y, 0);
  return a.map((v) => v / t);
};
const W = norm(WEEKDAY);
const WE = norm(WEEKEND);
// share of a week's use in each [day][hour]
const WEEK = DAYS.map((d) => (d === 'SUN' || d === 'SAT' ? WE : W).map((v) => v / 7));

// ISO 8601 duration → days (P1D, P1M, P3M, P1Y …). Unknown → a quarter (typical bill).
export function periodDays(iso) {
  const m = typeof iso === 'string' && iso.toUpperCase().match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?/);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return 91.25;
  return (+m[1] || 0) * 365 + (+m[2] || 0) * 30.4167 + (+m[3] || 0) * 7 + (+m[4] || 0);
}
// "07:00", "0700", "07:00:00+10:00", "T0700" → hour of day (0–24)
function hourOf(t, end) {
  const m = String(t || '').replace(/^T/, '').match(/^(\d{1,2}):?(\d{2})?/);
  if (!m) return end ? 24 : 0;
  let h = Number(m[1]) + Number(m[2] || 0) / 60;
  if (end && h === 0) h = 24;
  return Math.min(24, h);
}
// mm-dd → day of year (1–365)
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function doy(mmdd) {
  const m = String(mmdd || '').match(/(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return CUM[Math.min(11, Math.max(0, Number(m[1]) - 1))] + Number(m[2]);
}
export function periodLength(p) {
  const a = doy(p.sd);
  const b = doy(p.ed);
  if (a === null || b === null) return 365;
  return b >= a ? b - a + 1 : 365 - a + 1 + b;
}

// Cost of `units` through stepped blocks [{p: price, v: volume}] (last block has no volume)
function blockCost(units, blocks) {
  if (!blocks?.length) return null;
  let left = units;
  let cost = 0;
  for (let i = 0; i < blocks.length && left > 0; i++) {
    const b = blocks[i];
    const take = b.v && i < blocks.length - 1 ? Math.min(left, b.v) : left;
    cost += take * b.p;
    left -= take;
  }
  if (left > 0) cost += left * blocks[blocks.length - 1].p;
  return cost;
}
// Usage over `days` with blocks measured per `per` (e.g. first 1,000 kWh per quarter)
function steppedCost(units, days, blocks, per) {
  const pd = periodDays(per);
  const n = days / pd;
  if (n <= 0) return 0;
  return n * blockCost(units / n, blocks);
}

// Share of usage falling in each time-of-use window, from the residential profile.
export function touShares(tou) {
  const shares = tou.map(() => 0);
  let covered = 0;
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) {
      const idx = tou.findIndex((r) =>
        (r.win || []).some((w) => {
          const days = w.days?.length ? w.days : DAYS;
          if (!days.includes(DAYS[d])) return false;
          const s = hourOf(w.s);
          const e = hourOf(w.e, true);
          const mid = h + 0.5;
          return s <= e ? mid >= s && mid < e : mid >= s || mid < e;
        })
      );
      const target = idx >= 0 ? idx : Math.max(0, tou.findIndex((r) => r.type === 'OFF_PEAK'));
      shares[target] += WEEK[d][h];
      if (idx >= 0) covered += WEEK[d][h];
    }
  return { shares, covered };
}

/**
 * Estimated annual cost of one fuel on a plan.
 * @param {object} plan normalised plan record
 * @param {'E'|'G'} fuel
 * @param {object} o { usage, cl (controlled-load kWh), solar (exported kWh), conditional (bool) }
 */
export function annualCost(plan, fuel, o = {}) {
  const c = fuel === 'G' ? plan.g : plan.e;
  if (!c?.tp?.length) return null;
  const usage = Number(o.usage ?? DEFAULTS[fuel].usage);
  const flags = [];
  let supply = 0;
  let energy = 0;
  // Tariff periods of different charge types add together; periods of the same type split the year.
  const byType = new Map();
  for (const p of c.tp) (byType.get(p.ty || 'OTHER') || byType.set(p.ty || 'OTHER', []).get(p.ty || 'OTHER')).push(p);
  for (const periods of byType.values()) {
    const lens = periods.map(periodLength);
    const total = lens.reduce((a, b) => a + b, 0) || 365;
    periods.forEach((p, i) => {
      const days = (lens[i] / total) * 365;
      const u = usage * (days / 365) * (fuel === 'G' && p.unit === 'KWH' ? 1 / 3.6 : 1);
      if (p.sup !== null && p.sup !== undefined) supply += p.sup * days;
      if (p.bands?.length) {
        supply += p.bands[0].p * days;
        if (!flags.includes('banded supply')) flags.push('banded supply');
      }
      if (p.kind === 'single') energy += steppedCost(u, days, p.blocks, p.per) ?? 0;
      else if (p.kind === 'tou') {
        const { shares } = touShares(p.tou);
        p.tou.forEach((r, j) => (energy += steppedCost(u * shares[j], days, r.blocks, r.per) ?? 0));
      } else if (p.kind === 'demand' && !flags.includes('demand charges')) flags.push('demand charges');
    });
  }
  // Controlled load (e.g. off-peak hot water)
  let cl = 0;
  if (fuel === 'E' && o.cl > 0) {
    const x = c.cl?.[0];
    if (x) {
      if (x.sup) supply += x.sup * 365;
      if (x.kind === 'tou' && x.tou?.length) {
        const { shares } = touShares(x.tou);
        x.tou.forEach((r, j) => (cl += steppedCost(o.cl * shares[j], 365, r.blocks, r.per) ?? 0));
      } else cl += steppedCost(o.cl, 365, x.blocks, x.per) ?? 0;
    } else {
      energy += (energy / Math.max(1, usage)) * o.cl;
      flags.push('no controlled-load rate; general rate used');
    }
  }
  // Ongoing fees (membership, contribution)
  let fees = 0;
  const PER_YEAR = { ANNUAL: 1, MONTHLY: 12, WEEKLY: 52, DAILY: 365, BIANNUAL: 2 };
  for (const f of c.fees || []) if (['MEMBERSHIP', 'CONTRIBUTION'].includes(f.type) && PER_YEAR[f.term] && f.amt) fees += f.amt * PER_YEAR[f.term];
  // Discounts: guaranteed always; conditional (pay on time, direct debit) only if asked
  let disc = 0;
  for (const d of c.disc || []) {
    const guaranteed = d.type === 'GUARANTEED' || d.cat === 'GUARANTEED_DISCOUNT';
    if (!guaranteed && !(o.conditional && d.type === 'CONDITIONAL')) continue;
    if (d.m === 'percentOfUse' && d.rate) disc += (energy + cl) * d.rate;
    else if (d.m === 'percentOfBill' && d.rate) disc += (energy + cl + supply) * d.rate;
  }
  const beforeGst = supply + energy + cl + fees - disc;
  const gst = beforeGst * GST;
  // Solar feed-in credit (retailer-paid tariffs)
  let fit = 0;
  if (fuel === 'E' && o.solar > 0) {
    const best = bestFit(c);
    if (best !== null) fit = o.solar * best;
  }
  const total = beforeGst + gst - fit;
  return { total: Math.round(total), supply: supply * (1 + GST), energy: (energy + cl) * (1 + GST), fees: fees * (1 + GST), disc: disc * (1 + GST), fit, flags };
}

// Best retailer feed-in rate in $/kWh (single tariffs, or the average of time-varying ones)
export function bestFit(c) {
  let best = null;
  for (const f of c?.fit || []) {
    if (f.payer && f.payer !== 'RETAILER') continue;
    let v = null;
    if (f.kind === 'single' && f.blocks?.length) v = f.blocks[0].p;
    else if (f.tv?.length) {
      const vals = f.tv.map((t) => t.blocks?.[0]?.p).filter((x) => x !== undefined);
      if (vals.length) v = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

// Headline prices for display, in cents including GST
export function headline(c) {
  if (!c?.tp?.length) return null;
  const p = c.tp.find((x) => x.kind !== 'demand') || c.tp[0];
  const supply = c.tp.reduce((a, x) => a + (x.sup ?? x.bands?.[0]?.p ?? 0), 0);
  const cents = (v) => (v === null || v === undefined ? null : Math.round(v * (1 + GST) * 100 * 100) / 100);
  const out = { supply: cents(supply), kind: p.kind, single: null, tou: null };
  if (p.kind === 'single') out.single = cents(p.blocks?.[0]?.p);
  if (p.kind === 'tou') out.tou = p.tou.map((r) => ({ type: r.type, name: r.name, c: cents(r.blocks?.[0]?.p) }));
  const fit = bestFit(c);
  out.fit = fit === null ? null : Math.round(fit * 100 * 100) / 100;
  return out;
}

// Postcode helpers
export function postcodeState(pc) {
  const n = Number(pc);
  if (!Number.isFinite(n)) return null;
  if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return 'ACT';
  if (n >= 800 && n <= 999) return 'NT';
  if (n >= 1000 && n <= 2999) return 'NSW';
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return 'VIC';
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return 'QLD';
  if (n >= 5000 && n <= 5999) return 'SA';
  if (n >= 6000 && n <= 6999) return 'WA';
  if (n >= 7000 && n <= 7999) return 'TAS';
  return null;
}
// Postcode lists hold single postcodes ("3000") or ranges ("3000-3999")
export function inPostcodes(list, pc) {
  const n = Number(pc);
  return (list || []).some((x) => {
    const m = String(x).match(/^\s*(\d{3,4})\s*(?:-\s*(\d{3,4}))?\s*$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return n >= a && n <= b;
  });
}
export function availableAt(plan, pc) {
  if (plan.inc?.length && !inPostcodes(plan.inc, pc)) return false;
  if (plan.exc?.length && inPostcodes(plan.exc, pc)) return false;
  if (!plan.inc?.length) return plan.st?.includes(postcodeState(pc));
  return true;
}
