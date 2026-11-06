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

const META = {
  LIST_FAILED: ['availability', 'error'],
  DETAIL_FAILED: ['availability', 'error'],
  NO_PRODUCTS: ['availability', 'warning'],
  SCHEMA_REQUIRED: ['standards', 'error'],
  SCHEMA_ENUM: ['standards', 'error'],
  SCHEMA_TYPE: ['standards', 'error'],
  FORMAT_RATE: ['standards', 'error'],
  FORMAT_AMOUNT: ['standards', 'error'],
  FORMAT_DATETIME: ['standards', 'error'],
  FORMAT_DATE: ['standards', 'error'],
  FORMAT_CURRENCY: ['standards', 'error'],
  FORMAT_URI: ['standards', 'error'],
  FORMAT_DURATION: ['standards', 'error'],
  RULE_ADDITIONAL_VALUE: ['standards', 'warning'],
  RULE_ADDITIONAL_INFO: ['standards', 'warning'],
  RULE_NEGATIVE_ADJUSTMENT: ['standards', 'error'],
  RULE_LVR_SCALE: ['standards', 'error'],
  VERSION_OLDER: ['standards', 'info'],
  RATE_SCALE: ['accuracy', 'error'],
  RATE_OUT_OF_RANGE: ['accuracy', 'error'],
  RATE_NOT_NUMERIC: ['accuracy', 'error'],
  MORTGAGE_NO_PURPOSE: ['accuracy', 'warning'],
  MORTGAGE_NO_REPAYMENT_TYPE: ['accuracy', 'warning'],
  MORTGAGE_NO_COMPARISON_RATE: ['accuracy', 'warning'],
  NO_RATES: ['accuracy', 'warning'],
  STALE_LAST_UPDATED: ['accuracy', 'info'],
  NO_PRODUCT_LINK: ['links', 'warning'],
  LINK_BROKEN: ['links', 'error'],
  LINK_HOMEPAGE: ['links', 'warning'],
  LINK_NOT_HTTPS: ['links', 'warning'],
  LINK_BLOCKED: ['links', 'info'],
  LINK_ROBOTS: ['links', 'info'],
  LINK_UNCHECKED: ['links', 'info'],
  WEB_RATE_NOT_FOUND: ['website', 'warning'],
  WEB_COMP_NOT_FOUND: ['website', 'warning'],
  WEB_FEE_NOT_FOUND: ['website', 'warning'],
  WEB_UNVERIFIABLE: ['website', 'info'],
  RULE_CONDITIONAL: ['standards', 'error'],
  E_NO_TARIFFS: ['accuracy', 'error'],
  E_PRICE_IN_CENTS: ['accuracy', 'error'],
  E_PRICE_IMPLAUSIBLE: ['accuracy', 'warning'],
  E_NO_SUPPLY: ['accuracy', 'warning'],
  E_BLOCK_NO_PERIOD: ['accuracy', 'info'],
  E_FIT_IMPLAUSIBLE: ['accuracy', 'error'],
  E_EXPIRED: ['accuracy', 'warning'],
  E_NO_GEOGRAPHY: ['accuracy', 'warning'],
  DETAIL_DEFERRED: ['availability', 'info'],
  WEB_PRICE_NOT_FOUND: ['website', 'warning'],
  WEB_SUPPLY_NOT_FOUND: ['website', 'warning'],
  E_NO_PLAN_LINKS: ['links', 'info'],
  WEB_SITE_UNKNOWN: ['website', 'info'],
  WEB_NO_FACT_SHEETS: ['website', 'info'],
};

const LABELS = { ...ISSUE_LABELS, ...STANDARDS_LABELS, ...WEB_LABELS, ...ENERGY_LABELS, DETAIL_DEFERRED: 'Plan detail not fetched today (daily limit); previous details used where available' };
export function describe(code) {
  const [category, severity] = META[code] || ['accuracy', 'warning'];
  return { code, label: LABELS[code] || code, category, severity };
}
export const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
