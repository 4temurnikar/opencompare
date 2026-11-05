// Checks product payloads against the Consumer Data Standards.
// Schema rules come from pipeline/cds/banking-products.json (extracted from the official
// OpenAPI file by scripts/update-cds-schema.mjs). Field formats and the conditional
// "additionalValue" rules follow the standard's Common Field Types and Product Components tables.
import { readFileSync } from 'node:fs';

const CDS = JSON.parse(readFileSync(new URL('./cds/banking-products.json', import.meta.url), 'utf8'));
export const CDS_VERSION = { spec: CDS.specVersion, list: CDS.listVersion, detail: CDS.detailVersion };
const S = CDS.schemas;
const MAX_ISSUES_PER_PRODUCT = 40;

// ---- Common field types (CDS "Common Field Types")
const RE = {
  RateString: /^-?\d{1,16}(\.\d{1,16})?$/,
  AmountString: /^-?\d{1,16}\.\d{2,}$/,
  DateTimeString: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  DateString: /^\d{4}-\d{2}-\d{2}$/,
  CurrencyString: /^[A-Z]{3}$/,
  Duration: /^P(?!$)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/,
  Integer: /^\d+$/,
};
const FORMAT_CODE = {
  RateString: 'FORMAT_RATE',
  AmountString: 'FORMAT_AMOUNT',
  DateTimeString: 'FORMAT_DATETIME',
  DateString: 'FORMAT_DATE',
  CurrencyString: 'FORMAT_CURRENCY',
  URIString: 'FORMAT_URI',
};
function validUri(v) {
  if (typeof v !== 'string' || /\s/.test(v.trim()) || !v.trim()) return false;
  try {
    const u = new URL(v.trim());
    return !!u.protocol;
  } catch {
    return false;
  }
}
function checkType(cdsType, v) {
  if (cdsType === 'URIString') return validUri(v);
  if (cdsType === 'PositiveInteger') return Number.isInteger(v) && v > 0;
  if (cdsType === 'NaturalNumber') return Number.isInteger(v) && v >= 0;
  const re = RE[cdsType];
  return !re || (typeof v === 'string' && re.test(v));
}

export const STANDARDS_LABELS = {
  SCHEMA_REQUIRED: 'Mandatory field missing',
  SCHEMA_ENUM: 'Value not allowed by the standard',
  SCHEMA_TYPE: 'Wrong data type',
  FORMAT_RATE: 'Rate not in RateString format (e.g. "0.0624")',
  FORMAT_AMOUNT: 'Amount not in AmountString format (e.g. "395.00")',
  FORMAT_DATETIME: 'Date-time not in RFC 3339 format with UTC offset',
  FORMAT_DATE: 'Date not in YYYY-MM-DD format',
  FORMAT_CURRENCY: 'Currency not a 3-letter ISO 4217 code',
  FORMAT_URI: 'Not a valid URI',
  FORMAT_DURATION: 'Period not in ISO 8601 duration format (e.g. "P1Y")',
  RULE_ADDITIONAL_VALUE: 'additionalValue missing where the standard requires it',
  RULE_ADDITIONAL_INFO: 'additionalInfo missing for an OTHER type',
  RULE_NEGATIVE_ADJUSTMENT: 'Bonus, discount or penalty rate is negative (must be zero or positive)',
  RULE_LVR_SCALE: 'LVR constraint not in RateString format (80% should be "0.8")',
  VERSION_OLDER: 'Serves an older version of the product detail API',
};

// ---- Schema walk (full checks only for payloads served at the current detail version).
// makeWalker binds the walk to one sector's schema set, so energy and banking share the engine.
export function makeWalker(S) {
function deref(s) {
  while (s && s.$ref) s = S[s.$ref.split('/').pop()];
  return s;
}
return function walk(schema, value, path, out, mode) {
  schema = deref(schema);
  if (!schema || value === undefined || value === null) return;
  if (schema.allOf) for (const part of schema.allOf) walk(part, value, path, out, mode);
  const type = schema.type || (schema.properties ? 'object' : undefined);
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      if (mode === 'full') out.push({ code: 'SCHEMA_TYPE', path, value: short(value), msg: 'expected an object' });
      return;
    }
    if (mode === 'full')
      for (const r of schema.required || [])
        if (value[r] === undefined || value[r] === null || value[r] === '') out.push({ code: 'SCHEMA_REQUIRED', path: join(path, r), value: null, msg: `${r} is mandatory` });
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) walk(sub, value[k], join(path, k), out, mode);
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      if (mode === 'full') out.push({ code: 'SCHEMA_TYPE', path, value: short(value), msg: 'expected an array' });
      return;
    }
    value.slice(0, 300).forEach((v, i) => walk(schema.items, v, `${path}[${i}]`, out, mode));
    return;
  }
  if (type === 'string' && typeof value !== 'string') {
    if (mode === 'full') out.push({ code: 'SCHEMA_TYPE', path, value: short(value), msg: `expected a string${schema['x-cds-type'] ? ` (${schema['x-cds-type']})` : ''}` });
    return;
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    if (mode === 'full') out.push({ code: 'SCHEMA_TYPE', path, value: short(value), msg: 'expected true or false' });
    return;
  }
  if (schema.enum && mode === 'full' && !schema.enum.includes(value))
    out.push({ code: 'SCHEMA_ENUM', path, value: short(value), msg: `allowed: ${schema.enum.slice(0, 12).join(', ')}${schema.enum.length > 12 ? '…' : ''}` });
  const t = schema['x-cds-type'];
  if (t && FORMAT_CODE[t] && !checkType(t, value)) out.push({ code: FORMAT_CODE[t], path, value: short(value), msg: `must be in ${t} format` });
  if (t === 'ExternalRef' && /(Frequency|Period|period)$/.test(path) && typeof value === 'string' && !RE.Duration.test(value))
    out.push({ code: 'FORMAT_DURATION', path, value: short(value), msg: 'must be an ISO 8601 duration' });
};
}
const walk = makeWalker(S);
export { RE, checkType, FORMAT_CODE, short, join };
const join = (p, k) => (p ? `${p}.${k}` : k);
const short = (v) => (typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v)?.slice(0, 80) ?? String(v));

// ---- Conditional rules from the Product Components tables (apply to every version)
const empty = (v) => v === undefined || v === null || String(v).trim() === '';
const LENDING_VALUE = { FIXED: 'Duration', INTRODUCTORY: 'Duration', FLOATING: 'text', MARKET_LINKED: 'text', BUNDLE_DISCOUNT_FIXED: 'text', BUNDLE_DISCOUNT_VARIABLE: 'text', DISCOUNT: 'text', PENALTY: 'text' };
const DEPOSIT_VALUE = { FIXED: 'Duration', INTRODUCTORY: 'Duration', FLOATING: 'text', MARKET_LINKED: 'text', BONUS: 'text', BUNDLE_BONUS: 'text' };
const NON_NEGATIVE = new Set(['BONUS', 'BUNDLE_BONUS', 'INTRODUCTORY', 'BUNDLE_DISCOUNT_FIXED', 'BUNDLE_DISCOUNT_VARIABLE', 'DISCOUNT', 'PENALTY']);
const FEE_VALUE = { PERIODIC: 'Duration', LATE_PAYMENT: 'text' };
const FEATURE_VALUE = { FUNDS_AVAILABLE_AFTER: 'Duration', INTEREST_FREE: 'Duration', INTEREST_FREE_TRANSFERS: 'Duration', CASHBACK_OFFER: 'Amount', FREE_TXNS_ALLOWANCE: 'Amount', FREE_TXNS: 'Integer', BONUS_REWARDS: 'text', LOYALTY_PROGRAM: 'text', CARD_ACCESS: 'text', DIGITAL_WALLET: 'text', INSURANCE: 'text', NOTIFICATIONS: 'text', COMPLEMENTARY_PRODUCT_DISCOUNTS: 'text' };
const CONSTRAINT_VALUE = { MAX_BALANCE: 'Amount', MAX_LIMIT: 'Amount', MIN_BALANCE: 'Amount', MIN_LIMIT: 'Amount', OPENING_BALANCE: 'Amount', MAX_LVR: 'Rate', MIN_LVR: 'Rate' };
const ELIGIBILITY_VALUE = { MAX_AGE: 'Integer', MIN_AGE: 'Integer', MIN_INCOME: 'Amount', MIN_TURNOVER: 'Amount', EMPLOYMENT_STATUS: 'text', RESIDENCY_STATUS: 'text' };

function valueRule(kind, type, item, path, out) {
  const v = item.additionalValue;
  if (empty(v)) {
    out.push({ code: 'RULE_ADDITIONAL_VALUE', path: `${path}.additionalValue`, value: null, msg: `${type} requires additionalValue (${kind === 'Duration' ? 'an ISO 8601 duration' : kind === 'Amount' ? 'an AmountString' : kind === 'Rate' ? 'a RateString' : kind === 'Integer' ? 'a number' : 'a description'})` });
    return;
  }
  const s = String(v).trim();
  if (kind === 'Duration' && !RE.Duration.test(s)) out.push({ code: 'FORMAT_DURATION', path: `${path}.additionalValue`, value: short(v), msg: `${type} needs an ISO 8601 duration such as "P3Y"` });
  if (kind === 'Amount' && !RE.AmountString.test(s)) out.push({ code: 'FORMAT_AMOUNT', path: `${path}.additionalValue`, value: short(v), msg: `${type} needs an AmountString such as "1000.00"` });
  if (kind === 'Integer' && !RE.Integer.test(s)) out.push({ code: 'SCHEMA_TYPE', path: `${path}.additionalValue`, value: short(v), msg: `${type} needs a whole number` });
  if (kind === 'Rate') {
    if (!RE.RateString.test(s)) out.push({ code: 'FORMAT_RATE', path: `${path}.additionalValue`, value: short(v), msg: `${type} needs a RateString such as "0.8"` });
    else if (Number(s) > 1.5) out.push({ code: 'RULE_LVR_SCALE', path: `${path}.additionalValue`, value: short(v), msg: `${type} of ${s} reads as ${Number(s) * 100}%` });
  }
}
function otherRule(type, item, path, out) {
  if (type === 'OTHER' && empty(item.additionalInfo)) out.push({ code: 'RULE_ADDITIONAL_INFO', path: `${path}.additionalInfo`, value: null, msg: 'OTHER requires additionalInfo' });
}
function rateRules(list, typeKey, table, path, out) {
  (list || []).forEach((r, i) => {
    const t = r?.[typeKey];
    const p = `${path}[${i}]`;
    if (table[t]) valueRule(table[t], t, r, p, out);
    if (NON_NEGATIVE.has(t) && Number(r.rate) < 0) out.push({ code: 'RULE_NEGATIVE_ADJUSTMENT', path: `${p}.rate`, value: short(r.rate), msg: `${t} rate must be zero or positive` });
  });
}
function listRules(list, typeKey, table, path, out) {
  (list || []).forEach((x, i) => {
    const t = x?.[typeKey];
    if (table[t]) valueRule(table[t], t, x, `${path}[${i}]`, out);
    otherRule(t, x || {}, `${path}[${i}]`, out);
  });
}
// Older payload shapes keep fee amounts and rates directly on the fee.
function legacyFeeFormats(fees, out) {
  (fees || []).forEach((f, i) => {
    for (const [k, t] of [['amount', 'AmountString'], ['balanceRate', 'RateString'], ['transactionRate', 'RateString'], ['accruedRate', 'RateString']])
      if (f && !empty(f[k]) && !checkType(t, f[k])) out.push({ code: FORMAT_CODE[t], path: `fees[${i}].${k}`, value: short(f[k]), msg: `must be in ${t} format` });
  });
}

/**
 * @param {object} p merged product list + detail payload (with _xv = served detail version)
 * @returns {object[]} issues
 */
export function checkProduct(p) {
  const out = [];
  const v = Number(p._xv);
  const current = v === CDS.detailVersion;
  const clean = { ...p };
  for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
  // Full schema check at the current version; format checks only for older versions,
  // because older versions legitimately have different required fields and enums.
  walk(S.BankingProductDetailV7 || S[CDS.root], clean, '', out, current ? 'full' : 'formats');
  if (!current) legacyFeeFormats(p.fees, out);
  rateRules(p.lendingRates, 'lendingRateType', LENDING_VALUE, 'lendingRates', out);
  rateRules(p.depositRates, 'depositRateType', DEPOSIT_VALUE, 'depositRates', out);
  listRules(p.fees, 'feeType', FEE_VALUE, 'fees', out);
  listRules(p.features, 'featureType', FEATURE_VALUE, 'features', out);
  listRules(p.constraints, 'constraintType', CONSTRAINT_VALUE, 'constraints', out);
  listRules(p.eligibility, 'eligibilityType', ELIGIBILITY_VALUE, 'eligibility', out);
  // De-duplicate (allOf can visit a field twice) and cap
  const seen = new Set();
  const unique = out.filter((i) => {
    const k = `${i.code}|${i.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.slice(0, MAX_ISSUES_PER_PRODUCT);
}
