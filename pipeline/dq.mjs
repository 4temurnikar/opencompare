// One catalogue of every data-quality check: label, category and severity.
import { ISSUE_LABELS } from './normalise.mjs';
import { STANDARDS_LABELS } from './standards.mjs';
import { ENERGY_LABELS } from './energy/standards.mjs';

export const CATEGORIES = [
  { id: 'availability', label: 'API availability' },
  { id: 'standards', label: 'Standards conformance' },
  { id: 'accuracy', label: 'Data accuracy' },
  { id: 'links', label: 'Links' },
  { id: 'website', label: 'Matches the provider’s own pages' },
];

const WEB_LABELS = {
  LINK_BROKEN: 'Link is broken (error page or unreachable)',
  LINK_HOMEPAGE: 'Link goes to the homepage, not the specific product or plan',
  LINK_NOT_HTTPS: 'Link uses http rather than https',
  LINK_BLOCKED: 'Page blocked our automated check (bot protection)',
  LINK_ROBOTS: 'Page excluded from automated checks by robots.txt',
  LINK_UNCHECKED: 'Couldn’t check the link from our server (timed out, connection dropped or temporary server error); it may work in a browser',
  WEB_RATE_NOT_FOUND: 'CDR rate not found on the bank’s linked pages or PDFs',
  WEB_COMP_NOT_FOUND: 'CDR comparison rate not found on the bank’s linked pages or PDFs',
  WEB_FEE_NOT_FOUND: 'CDR fee amount not found on the bank’s linked pages or PDFs',
  WEB_UNVERIFIABLE: 'No readable page or PDF to check it against',
};

// Severity of a real problem, 1 (critical) to 5 (cosmetic). 0 = a note: worth knowing, not a fault.
export const LEVELS = {
  1: { name: 'Critical', help: 'The published data is wrong in a way that would mislead someone about the price, such as cents published as dollars.' },
  2: { name: 'Major', help: 'Materially affects comparisons or can’t be used: a price that doesn’t match the provider’s own fact sheet, no usable tariff, a broken link, a feed that’s down.' },
  3: { name: 'Moderate', help: 'Breaks the standard in a way that can trip up software reading the data: wrong codes, types or number formats, a field required in that situation missing, a doubtful price.' },
  4: { name: 'Minor', help: 'Breaks the standard but the meaning is still clear, such as "day" instead of "P1D", or a link to a homepage instead of the plan.' },
  5: { name: 'Cosmetic', help: 'A mandatory piece of descriptive text is missing, such as a display name. Nothing a customer pays is affected.' },
  0: { name: 'Note', help: 'Not a fault: an optional field not provided, a page that blocked our check, or something we couldn’t verify today.' },
};

// [category, level]
const META = {
  LIST_FAILED: ['availability', 2],
  DETAIL_FAILED: ['availability', 2],
  NO_PRODUCTS: ['availability', 3],
  DETAIL_DEFERRED: ['availability', 0],
  E_FEED_FAILED: ['availability', 2],
  E_DETAIL_FAILED: ['availability', 2],
  SCHEMA_REQUIRED: ['standards', 3], // refined by field below
  SCHEMA_ENUM: ['standards', 3],
  SCHEMA_TYPE: ['standards', 3],
  FORMAT_RATE: ['standards', 3],
  FORMAT_AMOUNT: ['standards', 3],
  FORMAT_DATETIME: ['standards', 4],
  FORMAT_DATE: ['standards', 4],
  FORMAT_CURRENCY: ['standards', 4],
  FORMAT_URI: ['standards', 4],
  FORMAT_DURATION: ['standards', 4],
  RULE_ADDITIONAL_VALUE: ['standards', 4],
  RULE_ADDITIONAL_INFO: ['standards', 5],
  RULE_NEGATIVE_ADJUSTMENT: ['standards', 3],
  RULE_LVR_SCALE: ['standards', 3],
  RULE_CONDITIONAL: ['standards', 3],
  VERSION_OLDER: ['standards', 0],
  RATE_SCALE: ['accuracy', 1],
  RATE_OUT_OF_RANGE: ['accuracy', 2],
  RATE_NOT_NUMERIC: ['accuracy', 2],
  MORTGAGE_NO_PURPOSE: ['accuracy', 3],
  MORTGAGE_NO_REPAYMENT_TYPE: ['accuracy', 3],
  MORTGAGE_NO_COMPARISON_RATE: ['accuracy', 3],
  NO_RATES: ['accuracy', 3],
  STALE_LAST_UPDATED: ['accuracy', 0],
  E_PRICE_IN_CENTS: ['accuracy', 1],
  E_FIT_IMPLAUSIBLE: ['accuracy', 1],
  E_NO_TARIFFS: ['accuracy', 2],
  E_EXPIRED: ['accuracy', 2],
  E_NO_GEOGRAPHY: ['accuracy', 2],
  E_PRICE_IMPLAUSIBLE: ['accuracy', 3],
  E_NO_SUPPLY: ['accuracy', 3],
  E_BLOCK_NO_PERIOD: ['accuracy', 4],
  LINK_BROKEN: ['links', 2],
  LINK_HOMEPAGE: ['links', 4],
  LINK_NOT_HTTPS: ['links', 4],
  NO_PRODUCT_LINK: ['links', 0], // the link fields are optional in the standard
  E_NO_PLAN_LINKS: ['links', 0],
  LINK_BLOCKED: ['links', 0],
  LINK_ROBOTS: ['links', 0],
  LINK_UNCHECKED: ['links', 0],
  WEB_PRICE_NOT_FOUND: ['website', 2], // matched to the plan's own fact sheet by plan ID
  WEB_SUPPLY_NOT_FOUND: ['website', 2],
  WEB_RATE_NOT_FOUND: ['website', 4], // banking: looser page matching, so a lead to review
  WEB_COMP_NOT_FOUND: ['website', 4],
  WEB_FEE_NOT_FOUND: ['website', 4],
  WEB_UNVERIFIABLE: ['website', 0],
  WEB_SITE_UNKNOWN: ['website', 0],
  WEB_NO_FACT_SHEETS: ['website', 0],
};

// A missing mandatory field matters more when it carries a price than when it's descriptive text
const PRICE_FIELD = /(^|\.)(unitPrice|rates|dailySupplyCharges?|dailySupplyCharge|rateBlockUType|tariffPeriod|singleRate|timeOfUseRates|amount|rate|fuelType|planId|type|pricingModel)(\[\])?$/;
const TEXT_FIELD = /(^|\.)(displayName|information|description|name|additionalInfo|brandName)$/;
export const fieldKey = (f) => String(f ?? '').replace(/\[\d+\]/g, '[]');
export function levelOf(code, field) {
  const base = META[code]?.[1] ?? 3;
  if (code === 'SCHEMA_REQUIRED' && field) {
    const k = fieldKey(field);
    if (TEXT_FIELD.test(k)) return 5;
    if (PRICE_FIELD.test(k)) return 2;
  }
  return base;
}
const severityOf = (level) => (level === 0 ? 'info' : level <= 2 ? 'error' : 'warning');

const LABELS = { ...ISSUE_LABELS, ...STANDARDS_LABELS, ...WEB_LABELS, ...ENERGY_LABELS, DETAIL_DEFERRED: 'Plan detail not fetched today (daily limit); previous details used where available' };
export function describe(code, field) {
  const category = META[code]?.[0] || 'accuracy';
  const level = levelOf(code, field);
  return { code, label: LABELS[code] || code, category, level, severity: severityOf(level) };
}
export const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const LEVEL_ORDER = (l) => (l === 0 ? 9 : l);

/**
 * Turn individual issues into findings. A finding is one kind of problem in one field for one
 * provider, however many plans or products it repeats across; counts are of findings, with the
 * number of plans or products affected alongside.
 */
export function summarise(issues) {
  const described = issues.map((i) => ({ ...i, ...describe(i.code, i.field), product: i.product ?? null }));
  described.sort((a, b) => LEVEL_ORDER(a.level) - LEVEL_ORDER(b.level));
  const groups = new Map();
  for (const i of described) {
    const field = ['SCHEMA_REQUIRED', 'SCHEMA_ENUM', 'SCHEMA_TYPE', 'RULE_CONDITIONAL'].includes(i.code) || i.code.startsWith('FORMAT_') ? fieldKey(i.field) : '';
    const key = `${i.code}|${field}|${i.level}`;
    const g = groups.get(key) || groups.set(key, { code: i.code, field: field || null, label: i.label, category: i.category, level: i.level, severity: i.severity, count: 0, products: new Set(), examples: [] }).get(key);
    g.count++;
    if (i.productId) g.products.add(i.productId);
    if (g.examples.length < 3) g.examples.push({ product: i.product, field: i.field ?? null, value: i.value ?? null, detail: i.detail ?? null });
  }
  const list = [...groups.values()].map((g) => ({ ...g, products: g.products.size })).sort((a, b) => LEVEL_ORDER(a.level) - LEVEL_ORDER(b.level) || b.products - a.products || b.count - a.count);
  const findings = list.filter((g) => g.level > 0);
  const levels = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const g of findings) levels[g.level]++;
  const affected = new Set(described.filter((i) => i.level > 0 && i.productId).map((i) => i.productId));
  return {
    described,
    groups: list,
    levels,
    findings: findings.length,
    notes: list.length - findings.length,
    affected: affected.size,
    // kept for older pages: findings at levels 1-2 / 3-5 / notes
    errors: findings.filter((g) => g.level <= 2).length,
    warnings: findings.filter((g) => g.level >= 3).length,
    infos: list.length - findings.length,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c.id, findings.filter((g) => g.category === c.id).length])),
  };
}
