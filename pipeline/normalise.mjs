// Turns raw CDR BankingProductDetail payloads into flat, comparable records.

export const CATEGORY_LABELS = {
  RESIDENTIAL_MORTGAGES: 'Home loans',
  TRANS_AND_SAVINGS_ACCOUNTS: 'Transaction & savings',
  TERM_DEPOSITS: 'Term deposits',
  CRED_AND_CHRG_CARDS: 'Credit & charge cards',
  PERS_LOANS: 'Personal loans',
  BUSINESS_LOANS: 'Business loans',
  MARGIN_LOANS: 'Margin loans',
  LEASES: 'Leases',
  OVERDRAFTS: 'Overdrafts',
  REGULATED_TRUST_ACCOUNTS: 'Trust accounts',
  TRADE_FINANCE: 'Trade finance',
  TRAVEL_CARDS: 'Travel cards',
};

// Products a typical consumer can't take out: kept in the data, left out of consumer comparisons.
const BUSINESS_NAME = /\b(business|commercial|corporate|company|companies|smsf|self[- ]managed super|farm|farming|agri\w*|equipment finance|not[- ]for[- ]profit|community organisation|trust account|practice)\b/i;
const STAFF_NAME = /\b(staff|employee)\b/i;
const SPECIAL_NAME = /\b(fee assistance|bridging|reverse mortgage|line of credit|construction only)\b/i;

const COMPARABLE_LENDING = new Set(['FIXED', 'VARIABLE', 'INTRODUCTORY', 'PURCHASE', 'CASH_ADVANCE', 'FLOATING', 'MARKET_LINKED']);
const COMPARABLE_DEPOSIT = new Set(['FIXED', 'VARIABLE', 'BONUS', 'BUNDLE_BONUS', 'INTRODUCTORY', 'FLOATING', 'MARKET_LINKED']);

/** ISO-8601 duration (P3Y, P18M, P90D, P1Y6M) → months (days/30.4 rounded). */
export function durationMonths(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().toUpperCase().match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?/);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const months = (+m[1] || 0) * 12 + (+m[2] || 0) + ((+m[3] || 0) * 7 + (+m[4] || 0)) / 30.4375;
  return Math.round(months * 10) / 10;
}

/** RateString ("0.0624") → percent number (6.24). Flags obviously mis-scaled values. */
function pct(v, issues, ctx) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    issues.push({ code: 'RATE_NOT_NUMERIC', ...ctx, value: v });
    return null;
  }
  if (n > 1 && n <= 40) {
    // Published as a percentage rather than a decimal fraction — a common holder error.
    issues.push({ code: 'RATE_SCALE', ...ctx, value: v });
    return round(n, 4);
  }
  if (n > 0.4) {
    issues.push({ code: 'RATE_OUT_OF_RANGE', ...ctx, value: v });
    return null;
  }
  return round(n * 100, 4);
}
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Collapse a rate's tiers into LVR / balance / term ranges. */
function tierRanges(tiers = []) {
  const r = { lvrMin: null, lvrMax: null, balMin: null, balMax: null, tierTermMin: null, tierTermMax: null, tierNote: null };
  for (const t of tiers || []) {
    const unit = (t.unitOfMeasure || '').toUpperCase();
    const name = (t.name || '').toLowerCase();
    let min = num(t.minimumValue);
    let max = num(t.maximumValue);
    if (unit === 'PERCENT' || /lvr|loan to value|loan-to-value/.test(name)) {
      // Normalise fractions (0.8) to percentages (80)
      if (max !== null && max <= 1.5) max = round(max * 100, 2);
      if (min !== null && min <= 1.5 && (max === null || max > 1.5)) min = round(min * 100, 2);
      r.lvrMin = min;
      r.lvrMax = max;
    } else if (unit === 'DOLLAR' || /balance|amount|deposit/.test(name)) {
      r.balMin = min;
      r.balMax = max;
    } else if (unit === 'MONTH' || unit === 'DAY') {
      const f = unit === 'DAY' ? 1 / 30.4375 : 1;
      r.tierTermMin = min !== null ? round(min * f, 1) : null;
      r.tierTermMax = max !== null ? round(max * f, 1) : null;
    }
    if (t.additionalInfo && !r.tierNote) r.tierNote = String(t.additionalInfo).slice(0, 160);
  }
  return r;
}

function feeFrequencyMonths(fee) {
  if (fee.feeType !== 'PERIODIC') return null;
  return durationMonths(fee.additionalValue);
}

const clip = (s, n = 240) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);

/**
 * @param {object} brand  register brand
 * @param {object[]} rawProducts  merged list+detail payloads
 * @returns {{products, rates, issues}}
 */
export function normaliseBrand(brand, rawProducts) {
  const products = [];
  const rates = [];
  const issues = [];
  const now = Date.now();

  for (const p of rawProducts) {
    if (!p || !p.productId) continue;
    if (p.effectiveTo && Date.parse(p.effectiveTo) < now) continue; // expired
    const key = `${brand.brandId}:${p.productId}`;
    const ctx = { brandId: brand.brandId, productId: p.productId, product: p.name };
    const category = p.productCategory || 'UNKNOWN';

    const featureTypes = (p.features || []).map((f) => f.featureType).filter(Boolean);
    // v7 nests fee values under fixedAmount / rateBased / variable; older versions keep them on the fee.
    const fees = (p.fees || []).map((f) => ({
      name: clip(f.name, 120),
      type: f.feeType,
      amount: num(f.amount ?? f.fixedAmount?.amount ?? f.variable?.feeMinimum),
      rate: pct(f.balanceRate ?? f.transactionRate ?? f.accruedRate ?? f.rateBased?.rate, issues, { ...ctx, field: 'fee' }),
      freqMonths: feeFrequencyMonths(f),
      info: clip(f.additionalInfo, 160),
    }));
    // Annual/monthly account-keeping fees, expressed per year
    let annualFee = null;
    let monthlyFee = null;
    for (const f of fees) {
      if (f.type !== 'PERIODIC' || f.amount === null || !f.freqMonths) continue;
      if (Math.abs(f.freqMonths - 1) < 0.2) monthlyFee = (monthlyFee ?? 0) + f.amount;
      else annualFee = (annualFee ?? 0) + f.amount * (12 / f.freqMonths);
    }
    const yearlyFees = annualFee === null && monthlyFee === null ? 0 : round((annualFee ?? 0) + (monthlyFee ?? 0) * 12, 2);
    const upfrontFees = round(fees.filter((f) => f.type === 'UPFRONT').reduce((s, f) => s + (f.amount ?? 0), 0), 2);

    const product = {
      key,
      brandId: brand.brandId,
      brand: brand.brandName,
      productId: p.productId,
      name: clip(p.name, 160) || '(unnamed product)',
      category,
      description: clip(p.description, 400),
      uri: p.applicationUri || p.additionalInformation?.overviewUri || null,
      overviewUri: p.additionalInformation?.overviewUri || null,
      feesUri: p.additionalInformation?.feesAndPricingUri || null,
      tailored: !!p.isTailored,
      business:
        BUSINESS_NAME.test(p.name || '') ||
        (p.eligibility || []).some((e) => ['BUSINESS', 'MIN_TURNOVER'].includes(e.eligibilityType)),
      staff: STAFF_NAME.test(p.name || '') || (p.eligibility || []).some((e) => e.eligibilityType === 'STAFF'),
      special: SPECIAL_NAME.test(p.name || ''),
      lastUpdated: p.lastUpdated || null,
      effectiveFrom: p.effectiveFrom || null,
      features: [...new Set(featureTypes)],
      offset: featureTypes.includes('OFFSET'),
      redraw: featureTypes.includes('REDRAW'),
      yearlyFees,
      monthlyFee,
      upfrontFees,
      fees,
      eligibility: (p.eligibility || []).map((e) => ({ type: e.eligibilityType, value: clip(e.additionalValue, 80), info: clip(e.additionalInfo, 160) })),
      constraints: (p.constraints || []).map((c) => ({ type: c.constraintType, value: c.additionalValue ?? null, info: clip(c.additionalInfo, 160) })),
      detailMissing: !!p._detailMissing,
    };
    products.push(product);

    // ---- Lending rates
    for (const lr of p.lendingRates || []) {
      const type = (lr.lendingRateType || 'UNKNOWN').toUpperCase();
      const rctx = { ...ctx, field: `lendingRate:${type}` };
      const rate = pct(lr.rate, issues, rctx);
      if (rate === null) continue;
      const tr = tierRanges(lr.tiers);
      const term = type === 'FIXED' || type === 'INTRODUCTORY' ? durationMonths(lr.additionalValue) : null;
      if (category === 'RESIDENTIAL_MORTGAGES' && COMPARABLE_LENDING.has(type)) {
        // At v7 these are mandatory and reported by the standards check instead.
        const v7 = Number(p._xv) >= 7;
        if (!lr.loanPurpose && !v7) issues.push({ code: 'MORTGAGE_NO_PURPOSE', ...rctx });
        if (!lr.repaymentType && !v7) issues.push({ code: 'MORTGAGE_NO_REPAYMENT_TYPE', ...rctx });
        if (lr.comparisonRate === undefined || lr.comparisonRate === null) issues.push({ code: 'MORTGAGE_NO_COMPARISON_RATE', ...rctx });
      }
      rates.push({
        k: key,
        kind: 'L',
        cat: category,
        type,
        comparable: COMPARABLE_LENDING.has(type),
        rate,
        comp: pct(lr.comparisonRate, issues, { ...rctx, field: 'comparisonRate' }),
        purpose: (lr.loanPurpose || 'UNSPECIFIED').toUpperCase(),
        repay: (lr.repaymentType || 'UNSPECIFIED').toUpperCase(),
        term,
        ...tr,
        info: clip(lr.additionalInfo, 200),
      });
    }

    // ---- Deposit rates
    for (const dr of p.depositRates || []) {
      const type = (dr.depositRateType || 'UNKNOWN').toUpperCase();
      const rctx = { ...ctx, field: `depositRate:${type}` };
      const rate = pct(dr.rate, issues, rctx);
      if (rate === null) continue;
      const tr = tierRanges(dr.tiers);
      const term = type === 'FIXED' || type === 'INTRODUCTORY' ? durationMonths(dr.additionalValue) ?? tr.tierTermMin : null;
      rates.push({
        k: key,
        kind: 'D',
        cat: category,
        type,
        comparable: COMPARABLE_DEPOSIT.has(type),
        rate,
        comp: null,
        purpose: null,
        repay: null,
        term,
        ...tr,
        info: clip(type === 'BONUS' || type === 'BUNDLE_BONUS' ? dr.additionalValue || dr.additionalInfo : dr.additionalInfo, 200),
      });
    }

    // Product-level checks
    const hasRates = (p.lendingRates?.length || 0) + (p.depositRates?.length || 0) > 0;
    if (!p._detailMissing && !hasRates && ['RESIDENTIAL_MORTGAGES', 'TERM_DEPOSITS', 'PERS_LOANS', 'CRED_AND_CHRG_CARDS'].includes(category))
      issues.push({ code: 'NO_RATES', ...ctx, field: category });
    if (p.lastUpdated && now - Date.parse(p.lastUpdated) > 365 * 864e5)
      issues.push({ code: 'STALE_LAST_UPDATED', ...ctx, value: p.lastUpdated });
    if (!p.applicationUri && !p.additionalInformation?.overviewUri)
      issues.push({ code: 'NO_PRODUCT_LINK', ...ctx });
  }
  return { products, rates, issues };
}

export const ISSUE_LABELS = {
  LIST_FAILED: 'Products endpoint unreachable or erroring',
  DETAIL_FAILED: 'Product detail endpoint failed',
  NO_PRODUCTS: 'Endpoint responded but published no products',
  EMPTY_PRODUCT_LIST: 'Products endpoint responded but published no products',
  RATE_SCALE: 'Rate published as a percentage instead of a decimal (e.g. 6.24 instead of 0.0624)',
  RATE_OUT_OF_RANGE: 'Implausible rate value (> 40%)',
  RATE_NOT_NUMERIC: 'Rate is not a number',
  MORTGAGE_NO_PURPOSE: 'Home-loan rate without loanPurpose (owner-occupied vs investment)',
  MORTGAGE_NO_REPAYMENT_TYPE: 'Home-loan rate without repaymentType (P&I vs interest-only)',
  MORTGAGE_NO_COMPARISON_RATE: 'Home-loan rate without a comparison rate',
  FIXED_NO_TERM: 'Fixed rate without a parseable term (additionalValue duration)',
  NO_RATES: 'Rate-bearing product published with no rates',
  STALE_LAST_UPDATED: 'Product lastUpdated older than 12 months',
  NO_PRODUCT_LINK: 'No applicationUri or overviewUri',
};
