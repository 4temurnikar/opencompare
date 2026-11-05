// Builds segment leaderboards and plain-English insights from normalised data.
import { config } from './config.mjs';

const S = config.scenarios;
const PURPOSE = { OWNER_OCCUPIED: 'owner-occupied', INVESTMENT: 'investment' };
const REPAY = { PRINCIPAL_AND_INTEREST: 'P&I', INTEREST_ONLY: 'interest-only' };
const termLabel = (m) => (m % 12 === 0 ? `${m / 12}-year` : `${m}-month`);
const f = (r) => (r === null || r === undefined ? '—' : `${r.toFixed(2)}%`);
const pp = (x) => `${Math.abs(x).toFixed(2)} pp`;
const median = (xs) => {
  const a = xs.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10000) / 10000;
};

const appliesLvr = (r, lvr) =>
  lvr === null || ((r.lvrMin === null || r.lvrMin < lvr || (r.lvrMin === 0 && lvr === 0)) && (r.lvrMax === null || r.lvrMax >= lvr));
const appliesBal = (r, bal) => (r.balMin === null || r.balMin <= bal) && (r.balMax === null || r.balMax >= bal);
const matchPurpose = (r, p) => !p || r.purpose === p || r.purpose === 'UNCONSTRAINED';
const matchRepay = (r, p) => !p || r.repay === p || r.repay === 'UNCONSTRAINED';
const termIs = (r, t) => t === null || (r.term !== null && Math.abs(r.term - t) < 0.5);

/**
 * Rank brands by their best qualifying rate.
 * dir 'asc' → lowest is best (lending); 'desc' → highest is best (deposits).
 */
// A rate this far better than the segment's median is treated as an outlier: usually a
// special-purpose product (fee assistance, staff, discounted green add-on) or a publishing error.
const OUTLIER_PP = 2;

function rankBrands(rows, products, dir, value = (r) => r.rate, { includeTailored = false } = {}) {
  const eligible = rows.filter((r) => {
    const p = products.get(r.k);
    return p && !p.business && !p.staff && !p.special && (!p.tailored || includeTailored) && value(r) !== null;
  });
  const mid = median(eligible.map(value));
  const excluded = [];
  const best = new Map();
  for (const r of eligible) {
    const p = products.get(r.k);
    const v = value(r);
    if (mid !== null && (dir === 'asc' ? v < mid - OUTLIER_PP : v > mid + OUTLIER_PP)) {
      excluded.push({ brandId: p.brandId, brand: p.brand, key: p.key, product: p.name, rate: v });
      continue;
    }
    const cur = best.get(p.brandId);
    const better = !cur || (dir === 'asc' ? v < cur.rate : v > cur.rate) || (v === cur.rate && (r.comp ?? 99) < (cur.comp ?? 99));
    if (better) best.set(p.brandId, { brandId: p.brandId, brand: p.brand, key: p.key, product: p.name, rate: v, comp: r.comp ?? null, offset: p.offset, tailored: p.tailored, extra: r._extra ?? null });
  }
  const ranking = [...best.values()].sort((a, b) => (dir === 'asc' ? a.rate - b.rate : b.rate - a.rate) || a.brand.localeCompare(b.brand));
  ranking.excluded = [...new Map(excluded.map((x) => [x.key, x])).values()];
  return ranking;
}

function board(id, group, label, scenario, ranking, dir) {
  return {
    id,
    group,
    label,
    scenario,
    dir,
    n: ranking.length,
    median: median(ranking.map((r) => r.rate)),
    ranking,
    excluded: ranking.excluded || [],
  };
}

export function buildInsights({ products: productList, rates }) {
  const products = new Map(productList.map((p) => [p.key, p]));
  const comparable = rates.filter((r) => r.comparable);
  const mort = comparable.filter((r) => r.cat === 'RESIDENTIAL_MORTGAGES' && r.kind === 'L');
  const boards = [];

  // ---------------- Home loans
  const homeSeg = (purpose, repay, type, term, lvr = S.homeLoanLvr, extra = () => true) =>
    rankBrands(
      mort.filter(
        (r) => r.type === type && termIs(r, term) && matchPurpose(r, purpose) && matchRepay(r, repay) && appliesLvr(r, lvr) && extra(r)
      ),
      products,
      'asc'
    );

  for (const purpose of ['OWNER_OCCUPIED', 'INVESTMENT']) {
    for (const repay of ['PRINCIPAL_AND_INTEREST', 'INTEREST_ONLY']) {
      const base = `hl-${purpose === 'OWNER_OCCUPIED' ? 'oo' : 'inv'}-${repay === 'PRINCIPAL_AND_INTEREST' ? 'pi' : 'io'}`;
      const lab = `${PURPOSE[purpose]} ${REPAY[repay]}`;
      boards.push(board(`${base}-var`, 'Home loans', `Variable, ${lab}`, `${S.homeLoanLvr}% LVR`, homeSeg(purpose, repay, 'VARIABLE', null), 'asc'));
      for (const t of S.homeLoanFixedTerms)
        boards.push(board(`${base}-fix${t}`, 'Home loans', `${termLabel(t)} fixed, ${lab}`, `${S.homeLoanLvr}% LVR`, homeSeg(purpose, repay, 'FIXED', t), 'asc'));
    }
  }
  const offsetOO = rankBrands(
    mort.filter((r) => r.type === 'VARIABLE' && matchPurpose(r, 'OWNER_OCCUPIED') && matchRepay(r, 'PRINCIPAL_AND_INTEREST') && appliesLvr(r, S.homeLoanLvr) && products.get(r.k)?.offset),
    products,
    'asc'
  );
  boards.push(board('hl-oo-pi-var-offset', 'Home loans', 'Variable with offset, owner-occupied P&I', `${S.homeLoanLvr}% LVR`, offsetOO, 'asc'));

  // ---------------- Term deposits
  const td = comparable.filter((r) => r.cat === 'TERM_DEPOSITS' && r.kind === 'D' && r.type === 'FIXED' && appliesBal(r, S.depositBalance));
  for (const t of S.termDepositTerms)
    boards.push(
      board(`td-${t}`, 'Term deposits', `${termLabel(t)} term deposit`, `$${S.depositBalance.toLocaleString('en-AU')} deposit`, rankBrands(td.filter((r) => termIs(r, t)), products, 'desc'), 'desc')
    );

  // ---------------- Savings (base + bonus per product)
  const sav = comparable.filter((r) => r.cat === 'TRANS_AND_SAVINGS_ACCOUNTS' && r.kind === 'D' && appliesBal(r, S.depositBalance));
  const perProduct = new Map();
  for (const r of sav) {
    const e = perProduct.get(r.k) || { k: r.k, base: null, bonus: null, intro: null, bonusInfo: null, introTerm: null };
    if (['VARIABLE', 'FLOATING', 'MARKET_LINKED'].includes(r.type)) e.base = Math.max(e.base ?? 0, r.rate);
    else if (r.type === 'BONUS' || r.type === 'BUNDLE_BONUS') {
      if (r.rate > (e.bonus ?? -1)) {
        e.bonus = r.rate;
        e.bonusInfo = r.info;
      }
    } else if (r.type === 'INTRODUCTORY') {
      if (r.rate > (e.intro ?? -1)) {
        e.intro = r.rate;
        e.introTerm = r.term;
      }
    }
    perProduct.set(r.k, e);
  }
  const savRows = [...perProduct.values()].map((e) => ({
    k: e.k,
    rate: Math.round(((e.base ?? 0) + (e.bonus ?? 0)) * 10000) / 10000,
    base: e.base,
    bonus: e.bonus,
    comp: null,
    _extra: { base: e.base, bonus: e.bonus, bonusInfo: e.bonusInfo, intro: e.intro, introTerm: e.introTerm },
  }));
  const savTotal = rankBrands(savRows.filter((r) => r.rate > 0), products, 'desc');
  const savBase = rankBrands(savRows.filter((r) => r.base), products, 'desc', (r) => r.base);
  boards.push(board('sav-total', 'Savings', 'Savings rate incl. bonus', `$${S.depositBalance.toLocaleString('en-AU')} balance`, savTotal, 'desc'));
  boards.push(board('sav-base', 'Savings', 'Savings base rate (no conditions)', `$${S.depositBalance.toLocaleString('en-AU')} balance`, savBase, 'desc'));

  // ---------------- Cards & personal loans
  const cards = comparable.filter((r) => r.cat === 'CRED_AND_CHRG_CARDS' && r.type === 'PURCHASE');
  boards.push(board('cc-purchase', 'Credit cards', 'Credit card purchase rate', 'any annual fee', rankBrands(cards, products, 'asc'), 'asc'));
  boards.push(board('cc-purchase-nofee', 'Credit cards', 'Credit card purchase rate, $0 annual fee', '$0 annual fee', rankBrands(cards.filter((r) => products.get(r.k)?.yearlyFees === 0), products, 'asc'), 'asc'));
  const pl = comparable.filter((r) => r.cat === 'PERS_LOANS');
  boards.push(board('pl-fixed', 'Personal loans', 'Fixed personal loan', 'advertised "from" rate', rankBrands(pl.filter((r) => r.type === 'FIXED'), products, 'asc', undefined, { includeTailored: true }), 'asc'));
  boards.push(board('pl-var', 'Personal loans', 'Variable personal loan', 'advertised "from" rate', rankBrands(pl.filter((r) => r.type === 'VARIABLE'), products, 'asc', undefined, { includeTailored: true }), 'asc'));

  const B = Object.fromEntries(boards.map((b) => [b.id, b]));
  const insights = [];
  const add = (o) => insights.push(o);
  const rankOf = (b, brandId) => b?.ranking.find((r) => r.brandId === brandId) ?? null;

  // 1. Segment leaders
  const leaderIds = ['hl-oo-pi-var', 'hl-inv-pi-var', 'hl-oo-pi-fix24', 'hl-oo-pi-fix36', 'hl-inv-io-var', 'td-6', 'td-12', 'sav-total', 'cc-purchase', 'pl-fixed'];
  for (const id of leaderIds) {
    const b = B[id];
    if (!b || b.n < 2) continue;
    const top = b.ranking[0];
    const gap = Math.abs(top.rate - b.median);
    const better = b.dir === 'asc' ? 'below' : 'above';
    add({
      id: `leader-${id}`,
      group: b.group,
      tone: 'best',
      headline: `${top.brand} leads ${lower(b.label)} at ${f(top.rate)}`,
      detail: `${top.product}${top.tailored ? ' (tailored — your rate depends on your profile)' : ''}${top.comp ? ` (comparison rate ${f(top.comp)})` : ''} is ${pp(gap)} ${better} the median of ${b.n} lenders (${f(b.median)}); ${b.scenario}. Runner-up: ${b.ranking[1].brand} at ${f(b.ranking[1].rate)}.`,
      brands: [top.brandId, b.ranking[1].brandId],
      board: id,
    });
  }

  // 2. Owner-occupied vs investment crossovers (the "Bank A wins if you live there" insight)
  const pairs = [['var', 'variable']].concat(S.homeLoanFixedTerms.map((t) => [`fix${t}`, `${termLabel(t)} fixed`]));
  for (const [suffix, lab] of pairs) {
    const oo = B[`hl-oo-pi-${suffix}`];
    const inv = B[`hl-inv-pi-${suffix}`];
    if (!oo?.n || !inv?.n) continue;
    const a = oo.ranking[0];
    const b = inv.ranking[0];
    if (a.brandId === b.brandId) {
      add({
        id: `same-${suffix}`,
        group: 'Home loans',
        tone: 'compare',
        headline: `${a.brand} is cheapest on ${lab} P&I for both owner-occupiers and investors`,
        detail: `${f(a.rate)} owner-occupied and ${f(b.rate)} for investors at ${S.homeLoanLvr}% LVR — an investor premium of ${pp(b.rate - a.rate)}.`,
        brands: [a.brandId],
        board: `hl-oo-pi-${suffix}`,
      });
      continue;
    }
    const aInv = rankOf(inv, a.brandId);
    const bOo = rankOf(oo, b.brandId);
    add({
      id: `cross-${suffix}`,
      group: 'Home loans',
      tone: 'compare',
      headline: `${lab[0].toUpperCase() + lab.slice(1)} P&I: ${a.brand} is better if you'll live in the property; ${b.brand} is better for investors`,
      detail:
        `Owner-occupied: ${a.brand} ${f(a.rate)}${bOo ? ` vs ${b.brand} ${f(bOo.rate)}` : ''}. ` +
        `Investment: ${b.brand} ${f(b.rate)}${aInv ? ` vs ${a.brand} ${f(aInv.rate)}` : ` (${a.brand} has no comparable investor rate)`}. At ${S.homeLoanLvr}% LVR.`,
      brands: [a.brandId, b.brandId],
      board: `hl-oo-pi-${suffix}`,
    });
  }

  // 3. Investor premium by lender
  {
    const oo = B['hl-oo-pi-var'];
    const inv = B['hl-inv-pi-var'];
    const prem = [];
    for (const r of oo?.ranking ?? []) {
      const i = rankOf(inv, r.brandId);
      if (i) prem.push({ brandId: r.brandId, brand: r.brand, gap: Math.round((i.rate - r.rate) * 100) / 100, oo: r.rate, inv: i.rate });
    }
    if (prem.length >= 3) {
      prem.sort((x, y) => x.gap - y.gap);
      const lo = prem[0];
      const hi = prem[prem.length - 1];
      add({
        id: 'investor-premium',
        group: 'Home loans',
        tone: 'market',
        headline: `Investor premium ranges from ${pp(lo.gap)} (${lo.brand}) to ${pp(hi.gap)} (${hi.brand})`,
        detail: `Gap between each lender's best variable P&I investor and owner-occupier rate, ${prem.length} lenders. Median premium ${pp(median(prem.map((p) => p.gap)))}. If you're an investor, ${lo.brand} penalises you least.`,
        brands: [lo.brandId, hi.brandId],
        board: 'hl-inv-pi-var',
      });
    }
  }

  // 4. Fixed vs variable
  {
    const v = B['hl-oo-pi-var']?.median;
    const fixes = S.homeLoanFixedTerms.map((t) => ({ t, m: B[`hl-oo-pi-fix${t}`]?.median, n: B[`hl-oo-pi-fix${t}`]?.n })).filter((x) => x.m !== null && x.n >= 2);
    if (v !== null && v !== undefined && fixes.length) {
      const cheapest = fixes.reduce((a, b) => (b.m < a.m ? b : a));
      const diff = cheapest.m - v;
      add({
        id: 'fixed-vs-variable',
        group: 'Home loans',
        tone: 'market',
        headline: `Typical ${termLabel(cheapest.t)} fixed rate is ${pp(diff)} ${diff < 0 ? 'below' : 'above'} typical variable`,
        detail: `Owner-occupied P&I medians across lenders: variable ${f(v)}; ` + fixes.map((x) => `${termLabel(x.t)} fixed ${f(x.m)}`).join(', ') + '.',
        brands: [],
        board: `hl-oo-pi-fix${cheapest.t}`,
      });
    }
  }

  // 5. LVR sensitivity
  {
    const low = homeSeg('OWNER_OCCUPIED', 'PRINCIPAL_AND_INTEREST', 'VARIABLE', null, S.lowLvr);
    const high = homeSeg('OWNER_OCCUPIED', 'PRINCIPAL_AND_INTEREST', 'VARIABLE', null, S.highLvr);
    const diffs = low
      .map((l) => {
        const h = high.find((x) => x.brandId === l.brandId);
        return h ? { ...l, high: h.rate, gap: Math.round((h.rate - l.rate) * 100) / 100 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.gap - a.gap);
    boards.push(board('hl-oo-pi-var-lvr60', 'Home loans', 'Variable, owner-occupied P&I', `${S.lowLvr}% LVR`, low, 'asc'));
    boards.push(board('hl-oo-pi-var-lvr85', 'Home loans', 'Variable, owner-occupied P&I', `${S.highLvr}% LVR`, high, 'asc'));
    if (diffs.length && diffs[0].gap > 0) {
      const d = diffs[0];
      add({
        id: 'lvr-reward',
        group: 'Home loans',
        tone: 'compare',
        headline: `${d.brand} rewards a bigger deposit the most: ${pp(d.gap)} cheaper at ${S.lowLvr}% LVR than ${S.highLvr}%`,
        detail: `${f(d.rate)} at ${S.lowLvr}% LVR vs ${f(d.high)} at ${S.highLvr}% (owner-occupied variable P&I). Best at ${S.lowLvr}% LVR overall: ${low[0].brand} ${f(low[0].rate)}.`,
        brands: [d.brandId, low[0].brandId],
        board: 'hl-oo-pi-var-lvr60',
      });
    }
  }

  // 6. Offset cost
  {
    const all = B['hl-oo-pi-var'];
    const off = B['hl-oo-pi-var-offset'];
    if (all?.n && off?.n) {
      const gap = off.ranking[0].rate - all.ranking[0].rate;
      add({
        id: 'offset-cost',
        group: 'Home loans',
        tone: 'compare',
        headline: gap > 0.004 ? `An offset account costs at least ${pp(gap)} extra in rate` : `You don't have to give up an offset to get the lowest variable rate`,
        detail: `Cheapest variable owner-occupied P&I with offset: ${off.ranking[0].brand} ${f(off.ranking[0].rate)} (${off.ranking[0].product}). Cheapest overall: ${all.ranking[0].brand} ${f(all.ranking[0].rate)}. Weigh the rate gap against your expected offset balance.`,
        brands: [off.ranking[0].brandId, all.ranking[0].brandId],
        board: 'hl-oo-pi-var-offset',
      });
    }
  }

  // 7. Term-deposit curve
  {
    const tds = S.termDepositTerms.map((t) => ({ t, b: B[`td-${t}`] })).filter((x) => x.b?.n);
    if (tds.length >= 2) {
      const best = tds.reduce((a, c) => (c.b.ranking[0].rate > a.b.ranking[0].rate ? c : a));
      const short = tds[0];
      const long = tds[tds.length - 1];
      const inverted = short.b.median > long.b.median;
      add({
        id: 'td-best',
        group: 'Term deposits',
        tone: 'best',
        headline: `Highest term-deposit rate: ${best.b.ranking[0].brand}, ${termLabel(best.t)} at ${f(best.b.ranking[0].rate)}`,
        detail: `Median ${termLabel(short.t)} ${f(short.b.median)} vs ${termLabel(long.t)} ${f(long.b.median)} — ${inverted ? 'shorter terms currently pay more than longer ones' : 'longer terms currently pay more'}. Based on a $${S.depositBalance.toLocaleString('en-AU')} deposit.`,
        brands: [best.b.ranking[0].brandId],
        board: `td-${best.t}`,
      });
    }
  }

  // 8. Savings: conditions vs none
  {
    const t = B['sav-total'];
    const b = B['sav-base'];
    if (t?.n && b?.n) {
      const top = t.ranking[0];
      add({
        id: 'savings-bonus',
        group: 'Savings',
        tone: 'compare',
        headline: `Bonus conditions are worth up to ${pp(top.rate - b.ranking[0].rate)} over the best no-strings savings rate`,
        detail: `${top.brand} pays up to ${f(top.rate)}${top.extra?.bonus ? ` (${f(top.extra.base)} base + ${f(top.extra.bonus)} bonus${top.extra.bonusInfo ? `: ${top.extra.bonusInfo}` : ''})` : ''}. Without conditions, ${b.ranking[0].brand} pays ${f(b.ranking[0].rate)}.`,
        brands: [top.brandId, b.ranking[0].brandId],
        board: 'sav-total',
      });
    }
  }

  // 9. Card annual-fee trade-off
  {
    const a = B['cc-purchase'];
    const n = B['cc-purchase-nofee'];
    if (a?.n && n?.n && a.ranking[0].brandId !== n.ranking[0].brandId) {
      const fee = products.get(a.ranking[0].key)?.yearlyFees ?? 0;
      add({
        id: 'card-fee',
        group: 'Credit cards',
        tone: 'compare',
        headline: `Lowest card rate isn't fee-free: ${a.ranking[0].brand} ${f(a.ranking[0].rate)} vs ${n.ranking[0].brand} ${f(n.ranking[0].rate)} with no annual fee`,
        detail: `${a.ranking[0].product} carries about $${fee.toFixed(0)} a year in fees. On a balance of $${Math.round(fee / Math.max(0.0001, (n.ranking[0].rate - a.ranking[0].rate) / 100)).toLocaleString('en-AU')} the two cost about the same per year.`,
        brands: [a.ranking[0].brandId, n.ranking[0].brandId],
        board: 'cc-purchase',
      });
    }
  }

  return { boards, insights };
}

function lower(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Compare today's comparable rates with the previous run's. */
export function diffRates(prevRates, rates, products) {
  if (!prevRates?.length) return [];
  // A product can publish several rates that share these fields (e.g. tiers we don't
  // model, package vs non-package). Group them and compare the sorted sets, so
  // ordering differences between runs never show up as "changes".
  const sig = (r) => [r.k, r.kind, r.type, r.purpose, r.repay, r.term, r.lvrMin, r.lvrMax, r.balMin, r.balMax, r.tierNote].join('|');
  const group = (list) => {
    const m = new Map();
    for (const r of list) {
      if (!r.comparable) continue;
      const s = sig(r);
      if (!m.has(s)) m.set(s, { r, vals: [] });
      m.get(s).vals.push(r.rate);
    }
    for (const g of m.values()) g.vals.sort((a, b) => a - b);
    return m;
  };
  const prev = group(prevRates);
  const cur = group(rates);
  const pmap = new Map(products.map((p) => [p.key, p]));
  const same = (a, b) => Math.abs(a - b) < 0.0001;
  const changes = [];
  for (const [s, { r, vals }] of cur) {
    const old = prev.get(s);
    if (!old) continue; // new rate, not a change
    let pairs;
    if (old.vals.length === vals.length) {
      if (vals.every((v, i) => same(v, old.vals[i]))) continue;
      pairs = vals.map((v, i) => [old.vals[i], v]).filter(([a, b]) => !same(a, b));
    } else {
      // Different number of rates: compare only the best one (lowest for loans, highest for deposits)
      const pick = (xs) => (r.kind === 'L' ? xs[0] : xs[xs.length - 1]);
      if (same(pick(old.vals), pick(vals))) continue;
      pairs = [[pick(old.vals), pick(vals)]];
    }
    const p = pmap.get(r.k);
    for (const [from, to] of pairs)
      changes.push({
        k: r.k,
        brandId: p?.brandId,
        brand: p?.brand,
        product: p?.name,
        cat: r.cat,
        type: r.type,
        purpose: r.purpose,
        repay: r.repay,
        term: r.term,
        lvrMax: r.lvrMax,
        from,
        to,
        delta: Math.round((to - from) * 10000) / 10000,
      });
  }
  return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
