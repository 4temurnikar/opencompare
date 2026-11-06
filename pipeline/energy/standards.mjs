// Consumer Data Standards checks for energy generic plans.
// Schema rules come from pipeline/cds/energy-plans.json (extracted from the official OpenAPI
// file); the conditional rules below are the "Required if / Mandatory if" statements in it.
import { readFileSync } from 'node:fs';
import { makeWalker, RE, short } from '../standards.mjs';

const CDS = JSON.parse(readFileSync(new URL('../cds/energy-plans.json', import.meta.url), 'utf8'));
export const ENERGY_CDS = { spec: CDS.specVersion, list: CDS.listVersion, detail: CDS.detailVersion };
const walk = makeWalker(CDS.schemas);
const MAX = 40;
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function need(cond, value, path, msg, out) {
  if (cond && empty(value)) out.push({ code: 'RULE_CONDITIONAL', path, value: null, msg });
}

function contractRules(c, path, fuel, planType, out) {
  if (!c) return;
  const pm = c.pricingModel;
  if (fuel === 'gas' && pm && pm !== 'SINGLE_RATE') out.push({ code: 'RULE_CONDITIONAL', path: `${path}.pricingModel`, value: pm, msg: 'gas contracts must use SINGLE_RATE' });
  need(c.isFixed === false, c.variation, `${path}.variation`, 'variation is mandatory when isFixed is false', out);
  need(planType === 'MARKET', c.coolingOffDays, `${path}.coolingOffDays`, 'coolingOffDays is mandatory for MARKET plans', out);
  need(/_CONT_LOAD$/.test(pm || ''), c.controlledLoad, `${path}.controlledLoad`, `controlledLoad is required for ${pm}`, out);
  if (c.benefitPeriod && c.termType && c.termType !== 'ONGOING') out.push({ code: 'RULE_CONDITIONAL', path: `${path}.benefitPeriod`, value: short(c.benefitPeriod), msg: 'benefitPeriod should only be present when termType is ONGOING' });
  (c.tariffPeriod || []).forEach((p, i) => {
    const pp = `${path}.tariffPeriod[${i}]`;
    for (const k of ['startDate', 'endDate']) if (p[k] && !MMDD.test(p[k])) out.push({ code: 'FORMAT_DATE', path: `${pp}.${k}`, value: short(p[k]), msg: 'must be in mm-dd format' });
    const sct = p.dailySupplyChargeType || 'SINGLE';
    need(sct === 'SINGLE' && p.dailySupplyChargeType, p.dailySupplyCharge, `${pp}.dailySupplyCharge`, 'dailySupplyCharge is mandatory when dailySupplyChargeType is SINGLE', out);
    need(sct === 'BAND', p.bandedDailySupplyCharges, `${pp}.bandedDailySupplyCharges`, 'bandedDailySupplyCharges is mandatory when dailySupplyChargeType is BAND', out);
    need(p.rateBlockUType === 'singleRate', p.singleRate, `${pp}.singleRate`, 'singleRate is required when rateBlockUType is singleRate', out);
    need(p.rateBlockUType === 'timeOfUseRates', p.timeOfUseRates, `${pp}.timeOfUseRates`, 'timeOfUseRates is required when rateBlockUType is timeOfUseRates', out);
    need(p.rateBlockUType === 'demandCharges', p.demandCharges, `${pp}.demandCharges`, 'demandCharges is required when rateBlockUType is demandCharges', out);
    if (p.rateBlockUType === 'timeOfUseRates' && !c.timeZone && pm === 'TIME_OF_USE')
      out.push({ code: 'RULE_CONDITIONAL', path: `${path}.timeZone`, value: null, msg: 'timeZone is required when pricingModel is TIME_OF_USE' });
  });
  (c.discounts || []).forEach((d, i) => {
    const dp = `${path}.discounts[${i}]`;
    need(d.type === 'CONDITIONAL', d.category, `${dp}.category`, 'category is mandatory when the discount type is CONDITIONAL', out);
    if (d.methodUType) need(true, d[d.methodUType], `${dp}.${d.methodUType}`, `${d.methodUType} is required when methodUType is ${d.methodUType}`, out);
  });
  (c.fees || []).forEach((f, i) => {
    const fp = `${path}.fees[${i}]`;
    need(f.term && f.term !== 'PERCENT_OF_BILL', f.amount, `${fp}.amount`, 'amount is required unless term is PERCENT_OF_BILL', out);
    need(f.term === 'PERCENT_OF_BILL', f.rate, `${fp}.rate`, 'rate is required when term is PERCENT_OF_BILL', out);
  });
  (c.solarFeedInTariff || []).forEach((f, i) => {
    const fp = `${path}.solarFeedInTariff[${i}]`;
    need(f.tariffUType === 'singleTariff', f.singleTariff, `${fp}.singleTariff`, 'singleTariff is mandatory when tariffUType is singleTariff', out);
    need(f.tariffUType === 'timeVaryingTariffs', f.timeVaryingTariffs, `${fp}.timeVaryingTariffs`, 'timeVaryingTariffs is mandatory when tariffUType is timeVaryingTariffs', out);
  });
}

/** @param {object} p merged plan list item + detail (with _xv = served detail version) */
export function checkPlan(p) {
  const out = [];
  const current = Number(p._xv) === CDS.detailVersion;
  const clean = { ...p };
  for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
  walk(CDS.schemas.EnergyPlanDetailV3 || CDS.schemas[CDS.root], clean, '', out, current ? 'full' : 'formats');
  need(['ELECTRICITY', 'DUAL'].includes(p.fuelType), p.electricityContract, 'electricityContract', 'electricityContract is mandatory when fuelType is ELECTRICITY or DUAL', out);
  need(['GAS', 'DUAL'].includes(p.fuelType), p.gasContract, 'gasContract', 'gasContract is mandatory when fuelType is GAS or DUAL', out);
  if (p.geography) need(true, p.geography.distributors, 'geography.distributors', 'distributors must have at least one entry', out);
  contractRules(p.electricityContract, 'electricityContract', 'electricity', p.type, out);
  contractRules(p.gasContract, 'gasContract', 'gas', p.type, out);
  const seen = new Set();
  return out.filter((i) => !seen.has(i.code + i.path) && seen.add(i.code + i.path)).slice(0, MAX);
}

/** Plausibility checks on the normalised record (prices are $ excl. GST) */
export function checkAccuracy(rec) {
  const out = [];
  const now = Date.now();
  for (const [fuel, c] of [['electricity', rec.e], ['gas', rec.g]]) {
    if (!c) continue;
    if (!c.tp.length) out.push({ code: 'E_NO_TARIFFS', field: `${fuel}Contract.tariffPeriod`, detail: 'no tariff periods' });
    for (const p of c.tp) {
      const prices = p.kind === 'single' ? p.blocks.map((b) => b.p) : p.kind === 'tou' ? p.tou.flatMap((r) => r.blocks.map((b) => b.p)) : [];
      const limit = fuel === 'gas' ? 0.5 : 2;
      for (const v of prices) {
        if (v > 5) out.push({ code: 'E_PRICE_IN_CENTS', field: `${fuel} usage rate`, value: String(v), detail: `$${v} per unit looks like cents, not dollars` });
        else if (v > limit) out.push({ code: 'E_PRICE_IMPLAUSIBLE', field: `${fuel} usage rate`, value: String(v), detail: `$${v} per unit excl. GST is unusually high` });
        else if (v < 0) out.push({ code: 'E_PRICE_IMPLAUSIBLE', field: `${fuel} usage rate`, value: String(v), detail: 'usage rate is negative' });
      }
      // A free period (e.g. the Solar Sharer's free midday hours) is fine; every rate being zero isn't
      if (prices.length && prices.every((v) => v === 0)) out.push({ code: 'E_PRICE_IMPLAUSIBLE', field: `${fuel} usage rate`, value: '0', detail: 'every usage rate in this tariff period is zero' });
      // Large business sites can have high daily charges; homes shouldn't
      const supMax = rec.cu === 'BUSINESS' ? 60 : 10;
      if (p.sup !== null && p.sup > supMax) out.push({ code: p.sup > 50 && rec.cu !== 'BUSINESS' ? 'E_PRICE_IN_CENTS' : p.sup > 150 ? 'E_PRICE_IN_CENTS' : 'E_PRICE_IMPLAUSIBLE', field: `${fuel} daily supply`, value: String(p.sup), detail: `$${p.sup} a day excl. GST${rec.cu === 'BUSINESS' ? ' for a business plan' : ''}` });
      if (p.sup === null && !p.bands?.length && p.kind !== 'demand') out.push({ code: 'E_NO_SUPPLY', field: `${fuel} daily supply`, detail: 'no daily supply charge' });
      if (p.kind === 'single' && p.blocks.some((b) => b.v) && !p.per) out.push({ code: 'E_BLOCK_NO_PERIOD', field: `${fuel} stepped rate`, detail: 'stepped rates without a period; a quarter is assumed' });
      if (!p.kind) out.push({ code: 'E_NO_TARIFFS', field: `${fuel} tariff period ${p.name || ''}`.trim(), detail: 'no usable rate structure' });
    }
    for (const f of c.fit) for (const b of [...(f.blocks || []), ...(f.tv || []).flatMap((t) => t.blocks)]) if (b.p > 1) out.push({ code: 'E_FIT_IMPLAUSIBLE', field: 'solar feed-in', value: String(b.p), detail: `$${b.p} per kWh looks wrong (cents published as dollars?)` });
  }
  if (rec.et && Date.parse(rec.et) < now) out.push({ code: 'E_EXPIRED', field: 'effectiveTo', value: rec.et, detail: 'plan listed as current but its end date has passed' });
  if (rec.up && now - Date.parse(rec.up) > 2 * 365 * 864e5) out.push({ code: 'STALE_LAST_UPDATED', field: 'lastUpdated', value: rec.up });
  // Links are optional in the energy standard: reported once per retailer (E_NO_PLAN_LINKS), not per plan
  if (!rec.st.length) out.push({ code: 'E_NO_GEOGRAPHY', field: 'geography', detail: 'no postcodes or recognised networks, so it can’t be matched to an address' });
  return out;
}

export const ENERGY_LABELS = {
  E_FEED_FAILED: 'Plan feed unreachable or returning errors',
  E_DETAIL_FAILED: 'Plan detail couldn’t be read',
  RULE_CONDITIONAL: 'A field the standard requires in this situation is missing or wrong',
  E_NO_TARIFFS: 'Plan has no usable tariff',
  E_PRICE_IN_CENTS: 'Price looks like cents published as dollars',
  E_PRICE_IMPLAUSIBLE: 'Implausible price',
  E_NO_SUPPLY: 'No daily supply charge',
  E_BLOCK_NO_PERIOD: 'Stepped rates without a period',
  E_FIT_IMPLAUSIBLE: 'Implausible solar feed-in tariff',
  E_EXPIRED: 'Plan listed as current after its end date',
  E_NO_GEOGRAPHY: 'Plan can’t be matched to any location',
  WEB_PRICE_NOT_FOUND: 'CDR price doesn’t match the plan’s fact sheet',
  E_NO_PLAN_LINKS: 'Plans don’t link to their fact sheets or plan pages in the CDR data',
  WEB_SITE_UNKNOWN: 'Retailer website not identified, so fact sheets weren’t checked',
  WEB_NO_FACT_SHEETS: 'No plan fact sheets found on the retailer’s website yet',
  WEB_SUPPLY_NOT_FOUND: 'CDR daily supply charge doesn’t match the plan’s fact sheet',
};
