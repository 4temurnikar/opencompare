// OpenCompare front end (no build step, no dependencies)
import { setupEnergy } from './energy-ui.js';

const DATA = 'data/';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const pct = (r) => (r === null || r === undefined ? '\u2014' : `${r.toFixed(2)}%`);
const money = (n, dp = 0) => (n === null || n === undefined ? '\u2014' : `$${n.toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const termLabel = (m) => (m === null || m === undefined ? '' : m % 12 === 0 ? `${m / 12} yr` : `${Math.round(m)} mth`);
const fromColumnar = (d) => (d?.rows || []).map((row) => Object.fromEntries(d.columns.map((c, i) => [c, row[i]])));
const LABEL = {
  OWNER_OCCUPIED: 'Owner-occupied', INVESTMENT: 'Investment', UNCONSTRAINED: 'Any purpose', UNSPECIFIED: 'Not stated',
  PRINCIPAL_AND_INTEREST: 'P&I', INTEREST_ONLY: 'Interest only',
};
const CAT = {
  RESIDENTIAL_MORTGAGES: 'Home loans', TRANS_AND_SAVINGS_ACCOUNTS: 'Transaction & savings', TERM_DEPOSITS: 'Term deposits',
  CRED_AND_CHRG_CARDS: 'Credit & charge cards', PERS_LOANS: 'Personal loans', BUSINESS_LOANS: 'Business loans', MARGIN_LOANS: 'Margin loans',
  LEASES: 'Leases', OVERDRAFTS: 'Overdrafts', REGULATED_TRUST_ACCOUNTS: 'Trust accounts', TRADE_FINANCE: 'Trade finance', TRAVEL_CARDS: 'Travel cards',
};
const FEATURE = { OFFSET: 'Offset', REDRAW: 'Redraw', EXTRA_REPAYMENTS: 'Extra repayments', INTEREST_FREE: 'Interest-free days', UNLIMITED_TXNS: 'Unlimited txns', DIGITAL_WALLET: 'Digital wallet', CASHBACK_OFFER: 'Cashback' };

let D = {}; // loaded data
const productByKey = new Map();
const ratesByKey = new Map();

// ---------- matching helpers (mirror pipeline/insights.mjs)
const appliesLvr = (r, lvr) => !lvr || ((r.lvrMin === null || r.lvrMin < lvr || (r.lvrMin === 0 && lvr === 0)) && (r.lvrMax === null || r.lvrMax >= lvr));
const appliesBal = (r, bal) => (r.balMin === null || r.balMin <= bal) && (r.balMax === null || r.balMax >= bal);
const matchP = (v, want) => want === 'ANY' || v === want || v === 'UNCONSTRAINED';
const lvrText = (r) => (r.lvrMin === null && r.lvrMax === null ? "Any" : `<span style="white-space:nowrap">${r.lvrMin ?? 0}\u2013${r.lvrMax ?? 100}%</span>`);

function monthlyRepayment(P, ratePct, years, io) {
  const i = ratePct / 1200;
  if (io) return P * i;
  const n = years * 12;
  return i === 0 ? P / n : (P * i) / (1 - (1 + i) ** -n);
}

// ---------- boot
const get = (f) => fetch(`${DATA}${f}`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
let EN = null; // energy data
let energy = null; // energy UI
const BANKING_RENDERERS = new Set(['home', 'deposits', 'cards', 'all', 'rankings']);
let SITE_CFG = null;
let BRIEF = null;
async function load() {
  const files = ['meta', 'insights', 'boards', 'products', 'rates', 'brands', 'quality', 'changes'];
  const efiles = ['meta', 'insights', 'boards', 'quality', 'changes', 'retailers'];
  // Banking files are only requested when banking is published (meta.json present)
  const bankingP = get('meta.json').then(async (meta) => (meta ? [meta, ...(await Promise.all(files.slice(1).map((f) => get(`${f}.json`))))] : files.map(() => null)));
  const energyP = get('energy/meta.json').then(async (meta) => (meta ? [meta, ...(await Promise.all(efiles.slice(1).map((f) => get(`energy/${f}.json`))))] : null));
  // Site settings (email sign-up) and the weekly brief's list, both optional
  const extrasP = Promise.all([fetch('site.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null), get('brief/index.json')]);
  const [res, eres, [site, briefs]] = await Promise.all([bankingP, energyP.then((x) => x || [null]), extrasP]);
  SITE_CFG = site;
  BRIEF = (briefs?.briefs || []).filter((b) => b.published).sort((a, b) => (a.date < b.date ? 1 : -1))[0] || null;
  files.forEach((f, i) => (D[f] = res[i]));
  if (eres[0]) {
    EN = Object.fromEntries(efiles.map((f, i) => [f, eres[i]]));
    EN.insights ||= [];
    EN.boards ||= [];
    EN.retailers ||= [];
  }
  // Show only the sectors whose data is published
  document.querySelector('[data-group="banking"]')?.closest('.menu-group')?.toggleAttribute('hidden', !D.meta);
  document.querySelector('[data-group="energy"]')?.closest('.menu-group')?.toggleAttribute('hidden', !EN);
  if (!D.meta && !EN) {
    $('#freshness').textContent = 'No data yet \u2014 run the refresh pipeline';
    $('#tab-insights').innerHTML = `<div class="card empty">No data found in <code>site/data/</code>. Run <code>npm run refresh</code>.</div>`;
    return;
  }
  if (D.meta) {
    D.products = fromColumnar(D.products);
    D.rates = fromColumnar(D.rates);
    for (const p of D.products) productByKey.set(p.key, p);
    for (const r of D.rates) {
      if (!ratesByKey.has(r.k)) ratesByKey.set(r.k, []);
      ratesByKey.get(r.k).push(r);
    }
  }
  if (EN) energy = setupEnergy({ $, esc, money, table, bindFilters, sevBadge, pctOf, dqTotals, DATA, renderers, openDrawer, go, openBrandReport, EN, banking: !!D.meta, levelChips, site: () => SITE_CFG, brief: () => BRIEF });
  // Footer wording follows the sectors that are published
  if (D.meta) $('#foot-note').textContent = `Prices and rates are as published by each provider through the Consumer Data Right and may differ from what you're offered.${EN ? ' Energy cost estimates are based on the usage you enter and include GST.' : ''} This is general information only, not financial advice. Check the provider's fact sheet or product disclosure before deciding.`;
  const at = new Date((D.meta || EN.meta).generatedAt);
  const ageH = (Date.now() - at) / 36e5;
  $('#freshness').innerHTML = `<span class="dot ${ageH > 36 ? 'stale' : ''}"></span>Updated ${esc(at.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}`;
  renderAll();
  route();
}

const renderers = {};
function renderAll() {
  for (const k of Object.keys(renderers)) {
    if (BANKING_RENDERERS.has(k) && !D.meta) continue;
    if (['energy', 'retailers', 'energyInsights'].includes(k) && !EN) continue;
    renderers[k]();
  }
}
function openDrawer(html) {
  $('#drawer').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#drawer-body').innerHTML = html;
  $('#drawer-body').scrollTop = 0;
}
// Each menu address maps to a page section; banking product pages share sections and set a mode.
const ROUTES = {
  home: { tab: 'insights', section: 'top' },
  how: { tab: 'insights', section: 'sec-how' },
  insights: { tab: 'insights', section: 'sec-insights' },
  quality: { tab: 'insights', section: 'sec-quality' },
  about: { tab: 'insights', section: 'sec-about' },
  'all-insights': { tab: () => (EN ? 'energy-insights' : 'rankings'), nav: 'insights' },
  'banking-insights': { tab: 'rankings', nav: 'insights', group: 'banking' },
  electricity: { tab: 'energy', group: 'energy', apply: () => energy?.setMode('electricity'), needs: 'energy' },
  gas: { tab: 'energy', group: 'energy', apply: () => energy?.setMode('gas'), needs: 'energy' },
  solar: { tab: 'energy', group: 'energy', apply: () => energy?.setMode('solar'), needs: 'energy' },
  retailers: { tab: 'retailers', group: 'energy', needs: 'energy' },
  'data-quality': { tab: 'quality', nav: 'quality' },
  methodology: { tab: 'about', nav: 'about' },
  'home-loans': { tab: 'home', group: 'banking' },
  savings: { tab: 'deposits', group: 'banking', apply: () => setDepMode('savings') },
  'term-deposits': { tab: 'deposits', group: 'banking', apply: () => setDepMode('td') },
  'credit-cards': { tab: 'cards', group: 'banking', apply: () => setCpMode('cards') },
  'personal-loans': { tab: 'cards', group: 'banking', apply: () => setCpMode('pl') },
  products: { tab: 'all', group: 'banking' },
};
const LEGACY = { '': 'home', deposits: 'savings', cards: 'credit-cards', all: 'products', rankings: 'all-insights' };
function route() {
  let name = location.hash.slice(1);
  name = LEGACY[name] ?? name;
  if (!ROUTES[name]) name = 'home';
  let r = ROUTES[name];
  // Pages for a sector whose data isn't published go home
  if ((r.group === 'banking' && !D.meta) || (r.needs === 'energy' && !EN)) {
    name = 'home';
    r = ROUTES.home;
    history.replaceState(null, '', '#home');
  }
  const tab = typeof r.tab === 'function' ? r.tab() : r.tab;
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  setNav(r.nav || name);
  document.querySelectorAll('.menu-trigger').forEach((t) => t.classList.toggle('active', t.dataset.group === r.group));
  if (D.meta || EN) r.apply?.();
  closeMenus();
  if (r.section && r.section !== 'top') requestAnimationFrame(() => document.getElementById(r.section)?.scrollIntoView({ behavior: 'smooth' }));
  else window.scrollTo({ top: 0 });
}
function setNav(name) {
  document.querySelectorAll('#menu > a[href]').forEach((a) => {
    if (a.getAttribute('href') === `#${name}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('#menu .menu-panel a').forEach((a) => {
    if (a.getAttribute('href') === `#${name}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
function go(name) {
  if (location.hash === `#${name}`) route();
  else location.hash = name;
}
window.addEventListener('hashchange', route);
// Clicking the link you're already on (e.g. Insights twice) should still scroll to it.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (a && a.getAttribute('href') === location.hash) {
    e.preventDefault();
    route();
  }
});
// Highlight the menu item for the home-page section in view.
function watchSections() {
  if (!('IntersectionObserver' in window)) return;
  const map = { 'sec-hero': 'home', 'sec-how': 'home', 'sec-insights': 'insights', 'sec-quality': 'quality', 'sec-about': 'about' };
  const io = new IntersectionObserver(
    (entries) => {
      if ($('#tab-insights').hidden) return;
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setNav(map[vis.target.id]);
    },
    { rootMargin: '-35% 0px -55% 0px' }
  );
  Object.keys(map).forEach((id) => document.getElementById(id) && io.observe(document.getElementById(id)));
}

// Dropdown menus
function closeMenus(except) {
  document.querySelectorAll('.menu-trigger').forEach((t) => {
    if (t === except) return;
    t.setAttribute('aria-expanded', 'false');
    document.getElementById(t.getAttribute('aria-controls')).hidden = true;
  });
}
document.querySelectorAll('.menu-trigger').forEach((t) =>
  t.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    const open = t.getAttribute('aria-expanded') === 'true';
    closeMenus(t);
    t.setAttribute('aria-expanded', String(!open));
    panel.hidden = open;
  })
);
document.addEventListener('click', (e) => !e.target.closest('.menu-group') && closeMenus());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.menu-trigger[aria-expanded="true"]');
  if (open) {
    closeMenus();
    open.focus();
  }
});

// ---------- generic sortable table
function table(el, cols, rows, state, onRow) {
  state.sort ??= cols.find((c) => c.defaultSort)?.key ?? cols[0].key;
  state.dir ??= cols.find((c) => c.key === state.sort)?.defaultDir ?? 'asc';
  const col = cols.find((c) => c.key === state.sort) || cols[0];
  const val = col.sort || ((r) => r[col.key]);
  const sorted = [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return state.dir === 'asc' ? c : -c;
  });
  const limit = state.limit ?? 300;
  el.innerHTML = rows.length
    ? `<div class="table-wrap"><table><thead><tr>${cols
        .map((c) => `<th data-k="${c.key}" class="${c.n ? 'n' : ''}" ${c.key === state.sort ? `aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${esc(c.label)}</th>`)
        .join('')}</tr></thead><tbody>${sorted
        .slice(0, limit)
        .map((r, i) => `<tr data-i="${rows.indexOf(r)}" class="${i === 0 && state.highlightTop ? 'top1' : ''}">${cols.map((c) => `<td class="${c.n ? 'n' : ''} ${c.cls || ''}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div><div class="count">${rows.length.toLocaleString()} result${rows.length === 1 ? '' : 's'}${rows.length > limit ? ` \u2014 showing first ${limit}` : ''}</div>`
    : `<div class="table-wrap"><div class="empty">No products match these filters.</div></div>`;
  el.querySelectorAll('th').forEach((th) =>
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else {
        state.sort = k;
        state.dir = cols.find((c) => c.key === k).defaultDir || 'asc';
      }
      table(el, cols, rows, state, onRow);
    })
  );
  el.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => onRow?.(rows[+tr.dataset.i])));
}

const bankCell = (p) => `<div class="bank">${esc(p.brand)}</div><div class="prod">${esc(p.name)}${p.tailored ? ' <span class="tag warn">Tailored</span>' : ''}${p.business ? ' <span class="tag">Business</span>' : ''}${p.staff ? ' <span class="tag">Staff only</span>' : ''}</div>`;
const featureTags = (p) => (p.features || []).filter((f) => FEATURE[f]).map((f) => `<span class="tag ${f === 'OFFSET' ? 'good' : ''}">${FEATURE[f]}</span>`).join('');
const brandOptions = () => [...new Set(D.products.map((p) => p.brand))].sort().map((b) => `<option>${esc(b)}</option>`).join('');

const changeDesc = (c) =>
  [CAT[c.cat] || c.cat, c.type.toLowerCase().replace(/_/g, ' ') + (c.term ? ` ${termLabel(c.term)}` : ''), c.purpose && !['UNSPECIFIED', 'UNCONSTRAINED'].includes(c.purpose) ? (LABEL[c.purpose] || c.purpose).toLowerCase() : null, c.repay && !['UNSPECIFIED', 'UNCONSTRAINED'].includes(c.repay) ? LABEL[c.repay] || c.repay : null, c.lvrMax ? `up to ${c.lvrMax}% LVR` : null]
    .filter(Boolean)
    .join(', ');

// Business, staff-only and special-purpose products are hidden from consumer pages unless asked for.
const consumerOk = (p, includeBusiness) => includeBusiness || (!p.business && !p.staff && !p.special);
// Mark rates far better than the typical rate in the current view: usually special-purpose products or errors.
const OUTLIER_PP = 2;
function markOutliers(rows, dir, get = (r) => r.rate) {
  const vals = rows.map(get).filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (vals.length < 4) return rows;
  const m = vals.length >> 1;
  const mid = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  for (const r of rows) {
    const v = get(r);
    r.outlier = v !== null && (dir === 'asc' ? v < mid - OUTLIER_PP : v > mid + OUTLIER_PP);
  }
  return rows;
}
const outlierTag = '<span class="tag warn" title="Far from the typical rate. Usually a special-purpose product or a publishing error. Check the details before relying on it.">Check details</span>';
// Outliers sort after normal rows when sorting by rate, so they never top the table.
const rateSort = (get, dir) => (r) => (r.outlier ? (dir === 'asc' ? 1000 : -1000) : 0) + get(r);

// ---------- DATA-QUALITY TOTALS (shared by the home section and the report)
// Never round up to 100% (or down to 0%) unless it really is all (or none)
const pctOf = (a, b) => {
  if (!b) return '\u2014';
  if (a === b) return '100%';
  const v = (a / b) * 100;
  return `${v >= 99 ? Math.min(99.9, Math.floor(v * 10) / 10) : v < 1 && a > 0 ? '<1' : Math.round(v)}%`;
};
function dqTotals(src = D.quality) {
  const Q = Array.isArray(src) ? { brands: src.map((b) => ({ ...b, errors: 0, warnings: b.total, issues: b.issues.map((i) => ({ ...i, severity: 'warning', category: 'accuracy' })) })), categories: [] } : src || { brands: [] };
  const bs = Q.brands || [];
  const sum = (f) => bs.reduce((a, b) => a + (f(b) || 0), 0);
  const web = {};
  for (const k of ['urls', 'linksOk', 'linksBroken', 'linksHomepage', 'linksBlocked', 'linksRobots', 'linksSkipped', 'pdfsRead', 'pagesRead', 'ratesChecked', 'ratesFound', 'feesChecked', 'feesFound', 'productsChecked', 'productsMatched', 'productsUnverifiable', 'plansCovered', 'factSheetsFound']) web[k] = sum((b) => b.web?.[k]);
  web.linksChecked = web.urls - web.linksBlocked - web.linksRobots - web.linksSkipped;
  const std = { checked: sum((b) => b.standards?.checked), withIssues: sum((b) => b.standards?.withIssues) };
  const byCode = {};
  for (const b of bs)
    for (const g of b.issues || []) {
      const level = levelOfGroup(g);
      if (!level) continue;
      const k = `${g.code}|${g.field || ''}|${level}`;
      const e = (byCode[k] ??= { code: g.code, field: g.field || null, label: g.label, category: g.category, severity: g.severity, level, count: 0, plans: 0, brands: 0 });
      e.count += g.count;
      e.plans += g.products || 0;
      e.brands++;
    }
  const top = Object.values(byCode).sort((a, b) => a.level - b.level || b.brands - a.brands || b.count - a.count);
  const levels = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const b of bs) for (const [l, n] of Object.entries(levelsOf(b))) levels[l] += n;
  const findings = Object.values(levels).reduce((a, n) => a + n, 0);
  return { Q, bs, web, std, levels, findings, withFindings: bs.filter((b) => Object.values(levelsOf(b)).some(Boolean)).length, affected: sum((b) => b.affected), errors: sum((b) => b.errors), warnings: sum((b) => b.warnings), top, hasWeb: web.urls > 0 || web.ratesChecked > 0 || web.pagesRead + web.pdfsRead > 0 };
}
const SEV = { error: 'Error', warning: 'Warning', info: 'Note' };
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;
const DEFAULT_LEVELS = {
  1: { help: 'The published data is wrong in a way that would mislead someone about the price.' },
  2: { help: 'Materially affects comparisons or can’t be used, such as a broken link or a feed that’s down.' },
  3: { help: 'Breaks the standard in a way that can trip up software reading the data.' },
  4: { help: 'Breaks the standard but the meaning is still clear.' },
  5: { help: 'A mandatory piece of descriptive text is missing. Nothing a customer pays is affected.' },
  0: { help: 'Not a fault: an optional field not provided, a page that blocked our check, or something we couldn’t verify today.' },
};
const LEVEL_NAMES = { 1: 'Critical', 2: 'Major', 3: 'Moderate', 4: 'Minor', 5: 'Cosmetic', 0: 'Note' };
const SEV_TO_LEVEL = { error: 2, warning: 3, info: 0 };
// A badge for a severity level (1 critical … 5 cosmetic, 0 note); older data passes error/warning/info
const sevBadge = (s) => {
  const l = typeof s === 'number' ? s : SEV_TO_LEVEL[s] ?? 3;
  return `<span class="sev sev-l${l}">${l ? `${l} · ` : ''}${LEVEL_NAMES[l]}</span>`;
};
const levelOfGroup = (g) => g.level ?? SEV_TO_LEVEL[g.severity] ?? 3;
// Findings per level for a provider; older data (no levels) is mapped from error/warning counts
const levelsOf = (x) => x?.levels || { 1: 0, 2: x?.errors || 0, 3: x?.warnings || 0, 4: 0, 5: 0 };
const levelChips = (x, none = '<span class="status-ok">None</span>') => {
  const L = levelsOf(x);
  const chips = [1, 2, 3, 4, 5].filter((l) => L[l]).map((l) => `<span class="sev-n l${l}" title="Severity ${l}: ${LEVEL_NAMES[l]}">${L[l]} ${LEVEL_NAMES[l].toLowerCase()}</span>`).join('');
  return chips || none;
};

// ---------- HOME (one long page; the menu scrolls to its sections)
const BEST = [
  { board: 'hl-oo-pi-var', label: 'Home loan', note: 'To live in, variable, principal & interest, 80% LVR', link: 'home-loans' },
  { board: 'hl-inv-pi-var', label: 'Investment loan', note: 'Variable, principal & interest, 80% LVR', link: 'home-loans' },
  { board: 'hl-oo-pi-fix24', label: '2-year fixed', note: 'To live in, principal & interest, 80% LVR', link: 'home-loans' },
  { board: 'td-12', label: 'Term deposit', note: '12 months on a $10,000 deposit', link: 'term-deposits' },
  { board: 'sav-total', label: 'Savings', note: 'Including bonus interest, $10,000 balance', link: 'savings' },
];
const FEATURED = ['cross-var', 'investor-premium', 'fixed-vs-variable', 'offset-cost', 'savings-bonus', 'td-best', 'lvr-reward', 'card-fee'];
let bestSeg = 0;

renderers.insights = () => {
  if (EN) {
    energy.renderHome($('#tab-insights'));
    watchSections();
    return;
  }
  renderBankingHome();
};
const renderBankingHome = () => {
  const el = $('#tab-insights');
  const boards = new Map((D.boards || []).map((b) => [b.id, b]));
  const segs = BEST.map((x) => ({ ...x, b: boards.get(x.board) })).filter((x) => x.b?.n);
  const ins = D.insights || [];
  const featured = FEATURED.map((id) => ins.find((i) => i.id === id)).filter(Boolean).slice(0, 4);
  const run = D.changes?.runs?.[0];
  const brands = D.brands || [];
  const failing = brands.filter((b) => !b.ok).length;
  const T = dqTotals();
  const topIssues = T.top.slice(0, 5);
  const n = D.meta.brandsOk;

  el.innerHTML = `
    <section class="hero" id="sec-hero">
      <h2 class="display">${n} banks.<br />One honest comparison.</h2>
      <p class="lede">Every morning we read each Australian bank's official Open Banking data and show who is cheapest for your situation. Nobody pays to be listed or ranked.</p>
      <div class="cta">
        <a class="btn-primary" href="#home-loans">Compare home loans</a>
        <a class="btn-ghost" href="#how">How it works</a>
      </div>

      ${segs.length ? `<div class="board-card">
        <div class="board-bar"><span class="board-title">Today's best rates</span><span class="board-live"><span class="live-dot"></span>From this morning's data</span></div>
        <div class="seg-tabs" role="tablist" aria-label="Product">${segs.map((x, i) => `<button role="tab" data-i="${i}" aria-selected="${i === bestSeg}">${esc(x.label)}</button>`).join('')}</div>
        <div id="best-list"></div>
      </div>` : ''}
    </section>

    <section class="section" id="sec-how">
      <h2 class="section-title">How it works</h2>
      <p class="section-lede">Banks have to publish their products through the Consumer Data Right. We turn that raw data into a comparison you can trust.</p>
      <ol class="steps">
        <li class="step"><span class="step-n">1</span><h3>Read every bank's own data</h3><p>Each morning we call the public product APIs of all ${D.meta.brandsTotal} registered banks and brands, covering ${D.meta.products.toLocaleString('en-AU')} products and ${D.meta.rates.toLocaleString('en-AU')} rates.</p></li>
        <li class="step"><span class="step-n">2</span><h3>Compare like with like</h3><p>Rates are matched on what changes your price: owner-occupied or investment, repayment type, fixed term, deposit size and balance. Business, staff-only and special-purpose products are set aside.</p></li>
        <li class="step"><span class="step-n">3</span><h3>Explain what it means</h3><p>We pick out the leaders, the gaps between lenders and every rate that moved since the previous morning, in plain English.</p></li>
      </ol>
    </section>

    <section class="section" id="sec-insights">
      <h2 class="section-title">What the data shows today</h2>
      <p class="section-lede">Worked out automatically from this morning's rates.</p>
      <div class="insight-grid">${featured.map((i) => `<article class="insight"><h3>${esc(i.headline)}</h3><p>${esc(i.detail)}</p></article>`).join('')}</div>
      <div class="changes-box">
        <h3>Changed since the last check</h3>
        ${run?.count
          ? `<p class="muted">${run.count} published rate${run.count > 1 ? 's' : ''} changed: ${(() => { const up = run.changes.filter((c) => c.delta > 0).length; return `${up} went up and ${run.changes.length - up} went down`; })()}.</p>
             <ul class="changes">${run.changes
               .slice(0, 4)
               .map((c) => `<li><button class="change-row" data-k="${esc(c.k)}"><span><b>${esc(c.brand)}</b> ${esc(c.product)}<span class="c-what">${esc(changeDesc(c))}</span></span><span class="c-fig">${pct(c.from)} to <b class="${c.delta > 0 ? 'up' : 'down'}">${pct(c.to)}</b></span></button></li>`)
               .join('')}</ul>`
          : `<p class="muted">No published rates changed since the previous check.</p>`}
      </div>
      <p class="section-foot"><a class="btn-ghost" href="#all-insights">See all insights and rankings</a></p>
    </section>

    <section class="section" id="sec-quality">
      <h2 class="section-title">How good is the banks' data?</h2>
      <p class="section-lede">Banks must keep the product data they publish accurate and up to date. Each morning we check it against the Consumer Data Standards, test every link, and compare the rates and fees with the bank's own web pages and PDFs.</p>
      <div class="stat-grid">
        <div class="bigstat accent"><span class="bs-n">${(T.errors + T.warnings).toLocaleString('en-AU')}</span><span class="bs-l">problems found this morning across ${T.bs.filter((b) => b.errors + b.warnings).length} of ${T.bs.length} banks and brands</span></div>
        <div class="bigstat"><span class="bs-n">${T.hasWeb ? pctOf(T.web.ratesFound, T.web.ratesChecked) : '\u2014'}</span><span class="bs-l">of published rates also appear on the bank's own pages${T.hasWeb ? ` (${T.web.ratesFound.toLocaleString('en-AU')} of ${T.web.ratesChecked.toLocaleString('en-AU')})` : ''}</span></div>
        <div class="bigstat"><span class="bs-n">${T.std.checked ? pctOf(T.std.checked - T.std.withIssues, T.std.checked) : '\u2014'}</span><span class="bs-l">of products meet the data standard with no issues</span></div>
        <div class="bigstat"><span class="bs-n">${T.hasWeb ? T.web.linksBroken.toLocaleString('en-AU') : '\u2014'}</span><span class="bs-l">broken product links${T.hasWeb && T.web.linksHomepage ? `, plus ${T.web.linksHomepage} that just go to a homepage` : ''}</span></div>
        <div class="bigstat"><span class="bs-n">${brands.length - failing}<small>/${brands.length}</small></span><span class="bs-l">product APIs responding</span></div>
      </div>
      ${topIssues.length ? `<h3 class="sub-title">Most common problems</h3>
      <ul class="issue-rows">${topIssues.map((i) => `<li><span>${sevBadge(i.severity)} ${esc(i.label)}</span><span class="muted">${i.brands} bank${i.brands > 1 ? 's' : ''}, ${i.count.toLocaleString('en-AU')} instance${i.count > 1 ? 's' : ''}</span></li>`).join('')}</ul>` : ''}
      <p class="section-foot"><a class="btn-ghost" href="#data-quality">Open the full data-quality report</a></p>
    </section>

    <section class="section" id="sec-about">
      <h2 class="section-title">About</h2>
      <p class="section-lede">Open Banking Comparator is independent. It isn't owned by or affiliated with any bank, and no bank can pay to change where it appears.</p>
      <div class="faq">
        <details><summary>Where does the data come from?</summary><p>From each bank's own product APIs, published under the Consumer Data Right and listed on the official CDR Register. We don't use paid feeds or screen-scraping.</p></details>
        <details><summary>How often is it updated?</summary><p>Every morning at about 4:20 am Melbourne time. The time of the latest update is shown at the top of every page.</p></details>
        <details><summary>Why might the rate I'm offered be different?</summary><p>Banks publish their advertised rates. Your rate can depend on your deposit, income, credit history and negotiation, and tailored products are priced individually. Always confirm with the bank.</p></details>
        <details><summary>Why is a bank missing or out of date?</summary><p>Some banks' endpoints were down or returned errors this morning. They're listed in the data-quality report and are picked up again automatically when they recover.</p></details>
        <details><summary>Is this financial advice?</summary><p>No. It's general information to help you compare published products. It doesn't take your circumstances into account. Check the product disclosure documents before you decide.</p></details>
      </div>
      <p class="section-foot"><a class="btn-ghost" href="#methodology">Read the full methodology</a></p>
    </section>`;

  const drawBest = () => {
    const x = segs[bestSeg];
    if (!x) return;
    const list = $('#best-list', el);
    const top = x.b.ranking.slice(0, 5);
    list.innerHTML = `<p class="board-note">${esc(x.note)}</p>
      <ol class="best-rows">${top
        .map((r, i) => {
          const [w, f] = r.rate.toFixed(2).split('.');
          return `<li><button class="best-row ${i === 0 ? 'is-top' : ''}" data-k="${esc(r.key)}"><span class="br-rank">${i + 1}</span><span class="br-who"><b>${esc(r.brand)}</b><span>${esc(r.product)}</span></span><span class="br-rate">${w}<span class="br-frac">.${f}%</span></span></button></li>`;
        })
        .join('')}</ol>
      <div class="board-foot"><span class="muted">Typical rate across ${x.b.n} lenders: <b>${pct(x.b.median)}</b></span><a href="#${x.link}">Compare all</a></div>`;
    list.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => openProduct(b.dataset.k)));
  };
  el.querySelectorAll('.seg-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      bestSeg = +b.dataset.i;
      el.querySelectorAll('.seg-tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === b)));
      drawBest();
    })
  );
  drawBest();
  el.querySelectorAll('.change-row[data-k]').forEach((b) => b.addEventListener('click', () => openProduct(b.dataset.k)));
  watchSections();
};

// ---------- RANKINGS (full detail lives here)
renderers.rankings = () => {
  const el = $('#tab-rankings');
  const ins = (D.insights || []).filter((i) => i.id !== 'dq');
  const groups = [...new Set(ins.map((i) => i.group))];
  const boards = D.boards || [];
  el.innerHTML = `
    <h2 class="page-title">All insights</h2>
    <p class="muted">What the published rates show today, worked out automatically each morning.</p>
    ${groups
      .map(
        (g) => `<h3 class="group-title">${esc(g)}</h3><div class="notes">${ins
          .filter((i) => i.group === g)
          .map((i) => `<article class="note"><h3>${esc(i.headline)}</h3><p>${esc(i.detail)}</p>${i.board ? `<button class="textbtn" data-board="${esc(i.board)}">Show this ranking</button>` : ''}</article>`)
          .join('')}</div>`
      )
      .join('')}


    <h2 class="page-title" id="rankings">Rankings</h2>
    <p class="muted">Each lender's best published rate in the chosen category. Tailored products are left out because their rate depends on the applicant.</p>
    <div class="board-head"><label class="field">Category<select id="board-select">${[...new Set(boards.map((b) => b.group))]
      .map((g) => `<optgroup label="${esc(g)}">${boards.filter((b) => b.group === g).map((b) => `<option value="${esc(b.id)}">${esc(b.label)}, ${esc(b.scenario)} (${b.n} lenders)</option>`).join('')}</optgroup>`)
      .join('')}</select></label></div>
    <div id="board"></div>

    <h2 class="page-title" id="changes">Rate changes</h2>
    <div id="changes-list"></div>`;
  const sel = $('#board-select', el);
  sel.addEventListener('change', () => drawBoard(sel.value));
  el.querySelectorAll('[data-board]').forEach((b) =>
    b.addEventListener('click', () => {
      sel.value = b.dataset.board;
      drawBoard(sel.value);
      $('#rankings').scrollIntoView({ behavior: 'smooth' });
    })
  );
  if (boards.length) drawBoard(boards[0].id);
  drawChanges();
};

function drawBoard(id) {
  const b = D.boards.find((x) => x.id === id);
  const el = $('#board');
  if (!b || !b.n) return (el.innerHTML = `<div class="card empty">No lenders publish a comparable rate for this segment.</div>`);
  const vals = b.ranking.map((r) => r.rate);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  // bar length = "goodness": best lender gets the full bar
  const w = (v) => 12 + 88 * (b.dir === 'asc' ? (hi - v) / span : (v - lo) / span);
  el.innerHTML = `<div class="card"><div class="bars">${b.ranking
    .slice(0, 40)
    .map(
      (r, i) => `<div class="bar-row" data-k="${esc(r.key)}" title="${esc(r.product)}"><span class="rank">${i + 1}</span>
        <span class="who">${esc(r.brand)} <small>${esc(r.product)}</small></span>
        <span class="bar-track"><span class="bar-fill" style="width:${w(r.rate).toFixed(1)}%"></span></span>
        <span class="val">${pct(r.rate)}</span></div>`
    )
    .join('')}</div><p class="median-note">Typical rate across ${b.n} lenders: <b>${pct(b.median)}</b>. ${b.dir === 'asc' ? 'Lower is better.' : 'Higher is better.'}${b.n > 40 ? ' Top 40 shown.' : ''}</p>${
    b.excluded?.length
      ? `<p class="median-note">Set aside as unusual, so not ranked: ${b.excluded.map((x) => `<button class="textbtn small" data-k="${esc(x.key)}">${esc(x.brand)} ${esc(x.product)} (${pct(x.rate)})</button>`).join(', ')}.</p>`
      : ''
  }</div>`;
  el.querySelectorAll('.median-note [data-k]').forEach((x) => x.addEventListener('click', () => openProduct(x.dataset.k)));
  el.querySelectorAll('.bar-row').forEach((row) => row.addEventListener('click', () => openProduct(row.dataset.k)));
}

function drawChanges() {
  const el = $('#changes-list');
  const runs = D.changes?.runs || [];
  const all = runs.flatMap((r) => r.changes.map((c) => ({ ...c, at: r.at })));
  if (!all.length) return (el.innerHTML = `<div class="card empty">No rate changes recorded yet. Changes appear after the second daily refresh.</div>`);
  const st = { sort: 'at', dir: 'desc', limit: 200 };
  table(
    el,
    [
      { key: 'at', label: 'Detected', fmt: (c) => esc(new Date(c.at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) },
      { key: 'brand', label: 'Lender / product', fmt: (c) => `<div class="bank">${esc(c.brand)}</div><div class="prod">${esc(c.product)}</div>` },
      { key: 'cat', label: 'Rate', fmt: (c) => esc(changeDesc(c)) },
      { key: 'from', label: 'From', n: true, fmt: (c) => pct(c.from) },
      { key: 'to', label: 'To', n: true, fmt: (c) => pct(c.to) },
      { key: 'delta', label: 'Change', n: true, fmt: (c) => `<b style="color:var(${c.delta > 0 ? '--bad' : '--good'})">${c.delta > 0 ? '+' : '\u2212'}${Math.abs(c.delta).toFixed(2)}</b>`, sort: (c) => Math.abs(c.delta) },
    ],
    all,
    st,
    (c) => openProduct(c.k)
  );
}

// ---------- HOME LOANS
const hl = { purpose: 'OWNER_OCCUPIED', repay: 'PRINCIPAL_AND_INTEREST', type: 'VARIABLE', term: 36, lvr: 80, amount: 600000, years: 30, offset: false, tailored: false, business: false, best: true, brand: '', t: {} };
renderers.home = () => {
  const el = $('#tab-home');
  el.innerHTML = `
    <h2 class="page-title">Home loans</h2>
    <p class="muted">Every lender's published home-loan rates. Set your situation and the table updates.</p>
    <div class="filters" id="hl-f">
      <label class="field">Property use<select data-k="purpose"><option value="OWNER_OCCUPIED">Owner-occupied</option><option value="INVESTMENT">Investment</option></select></label>
      <label class="field">Repayments<select data-k="repay"><option value="PRINCIPAL_AND_INTEREST">Principal &amp; interest</option><option value="INTEREST_ONLY">Interest only</option></select></label>
      <label class="field">Rate type<select data-k="type"><option value="VARIABLE">Variable</option><option value="FIXED">Fixed</option></select></label>
      <label class="field" id="hl-term">Fixed term<select data-k="term"><option value="12">1 year</option><option value="24">2 years</option><option value="36">3 years</option><option value="48">4 years</option><option value="60">5 years</option></select></label>
      <label class="field">LVR %<input type="number" data-k="lvr" min="10" max="100" step="5" /></label>
      <label class="field">Loan amount<input type="number" data-k="amount" min="10000" step="10000" /></label>
      <label class="field">Loan term (yrs)<input type="number" data-k="years" min="1" max="40" /></label>
      <label class="field">Lender<select data-k="brand"><option value="">All lenders</option>${brandOptions()}</select></label>
      <label class="check"><input type="checkbox" data-k="offset" /> Offset only</label>
      <label class="check"><input type="checkbox" data-k="best" /> Best per lender</label>
      <label class="check"><input type="checkbox" data-k="tailored" /> Include tailored</label>
      <label class="check"><input type="checkbox" data-k="business" /> Show business products</label>
    </div>
    <div id="hl-table"></div>`;
  bindFilters($('#hl-f', el), hl, drawHome);
  drawHome();
};
function drawHome() {
  $('#hl-term').style.display = hl.type === 'FIXED' ? '' : 'none';
  const rows = [];
  const best = new Map();
  for (const r of D.rates) {
    if (r.cat !== 'RESIDENTIAL_MORTGAGES' || r.kind !== 'L' || r.type !== hl.type) continue;
    if (hl.type === 'FIXED' && (r.term === null || Math.abs(r.term - hl.term) >= 0.5)) continue;
    if (!matchP(r.purpose, hl.purpose) || !matchP(r.repay, hl.repay) || !appliesLvr(r, hl.lvr)) continue;
    const p = productByKey.get(r.k);
    if (!p || !consumerOk(p, hl.business) || (p.tailored && !hl.tailored) || (hl.offset && !p.offset) || (hl.brand && p.brand !== hl.brand)) continue;
    const key = hl.best ? p.brandId : p.key;
    const cur = best.get(key);
    if (!cur || r.rate < cur.r.rate) best.set(key, { r, p });
  }
  for (const { r, p } of best.values())
    rows.push({ ...r, p, monthly: monthlyRepayment(hl.amount, r.rate, hl.years, hl.repay === 'INTEREST_ONLY'), fees: p.yearlyFees });
  markOutliers(rows, 'asc');
  table(
    $('#hl-table'),
    [
      { key: 'brand', label: 'Lender / product', fmt: (r) => bankCell(r.p) + (r.outlier ? outlierTag : ''), sort: (r) => r.p.brand },
      { key: 'rate', label: 'Rate', n: true, cls: 'rate', fmt: (r) => pct(r.rate), defaultSort: true, sort: rateSort((r) => r.rate, 'asc') },
      { key: 'comp', label: 'Comparison', n: true, fmt: (r) => pct(r.comp) },
      { key: 'monthly', label: 'Monthly repayment', n: true, fmt: (r) => money(r.monthly) },
      { key: 'fees', label: 'Ongoing fees / yr', n: true, fmt: (r) => money(r.fees) },
      { key: 'lvr', label: 'LVR band', fmt: lvrText, sort: (r) => r.lvrMax ?? 100 },
      { key: 'features', label: 'Features', fmt: (r) => featureTags(r.p), sort: (r) => (r.p.offset ? 0 : 1) },
    ],
    rows,
    Object.assign(hl.t, { highlightTop: true }),
    (r) => openProduct(r.k)
  );
}

function bindFilters(root, state, redraw) {
  root.querySelectorAll('[data-k]').forEach((input) => {
    const k = input.dataset.k;
    if (input.type === 'checkbox') input.checked = !!state[k];
    else input.value = state[k];
    input.addEventListener(['number', 'search', 'text'].includes(input.type) ? 'input' : 'change', () => {
      state[k] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) || 0 : input.tagName === 'SELECT' && /^\d+$/.test(input.value) ? Number(input.value) : input.value;
      redraw();
    });
  });
}

// ---------- DEPOSITS
const dep = { mode: 'savings', balance: 10000, term: 12, conditions: true, business: false, brand: '', ts: {}, tt: {} };
renderers.deposits = () => {
  const el = $('#tab-deposits');
  el.innerHTML = `
    <h2 class="page-title" id="dep-title"></h2>
    <p class="muted" id="dep-intro"></p>
    <div class="filters" id="dep-f">
      <label class="field">Balance<input type="number" data-k="balance" min="0" step="1000" /></label>
      <label class="field" id="dep-term">Term<select data-k="term"><option value="1">1 month</option><option value="3">3 months</option><option value="4">4 months</option><option value="6">6 months</option><option value="9">9 months</option><option value="12">12 months</option><option value="18">18 months</option><option value="24">2 years</option><option value="36">3 years</option><option value="48">4 years</option><option value="60">5 years</option></select></label>
      <label class="field">Provider<select data-k="brand"><option value="">All providers</option>${brandOptions()}</select></label>
      <label class="check" id="dep-cond"><input type="checkbox" data-k="conditions" /> Include bonus rates (conditions apply)</label>
      <label class="check"><input type="checkbox" data-k="business" /> Show business products</label>
    </div><div id="dep-table"></div>`;
  bindFilters($('#dep-f', el), dep, drawDeposits);
  drawDeposits();
};
function setDepMode(m) {
  dep.mode = m;
  drawDeposits();
}
function drawDeposits() {
  $('#dep-title').textContent = dep.mode === 'td' ? 'Term deposits' : 'Savings accounts';
  $('#dep-intro').textContent = dep.mode === 'td' ? 'Fixed rates for your balance and term, with the interest you would earn at maturity.' : 'Base, bonus and introductory rates for your balance. Bonus rates come with monthly conditions.';
  $('#dep-term').style.display = dep.mode === 'td' ? '' : 'none';
  $('#dep-cond').style.display = dep.mode === 'savings' ? '' : 'none';
  const el = $('#dep-table');
  if (dep.mode === 'td') {
    const best = new Map();
    for (const r of D.rates) {
      if (r.cat !== 'TERM_DEPOSITS' || r.kind !== 'D' || r.type !== 'FIXED' || r.term === null || Math.abs(r.term - dep.term) >= 0.5 || !appliesBal(r, dep.balance)) continue;
      const p = productByKey.get(r.k);
      if (!p || !consumerOk(p, dep.business) || (dep.brand && p.brand !== dep.brand)) continue;
      const cur = best.get(p.key);
      if (!cur || r.rate > cur.r.rate) best.set(p.key, { r, p });
    }
    const rows = markOutliers([...best.values()].map(({ r, p }) => ({ ...r, p, interest: (dep.balance * r.rate * (dep.term / 12)) / 100 })), 'desc');
    return table(
      el,
      [
        { key: 'brand', label: 'Provider / product', fmt: (r) => bankCell(r.p) + (r.outlier ? outlierTag : ''), sort: (r) => r.p.brand },
        { key: 'rate', label: 'Rate p.a.', n: true, cls: 'rate', fmt: (r) => pct(r.rate), defaultSort: true, defaultDir: 'desc', sort: rateSort((r) => r.rate, 'desc') },
        { key: 'interest', label: 'Interest at maturity', n: true, fmt: (r) => money(r.interest, 2), defaultDir: 'desc' },
        { key: 'bal', label: 'Balance range', fmt: (r) => `${money(r.balMin)}${r.balMax ? `\u2013${money(r.balMax)}` : '+'}`, sort: (r) => r.balMin },
        { key: 'info', label: 'Notes', fmt: (r) => `<span class="small muted">${esc(r.info || r.tierNote || '')}</span>` },
      ],
      rows,
      Object.assign(dep.tt, { highlightTop: true }),
      (r) => openProduct(r.k)
    );
  }
  // Savings: base + best bonus per product at this balance
  const per = new Map();
  for (const r of D.rates) {
    if (r.cat !== 'TRANS_AND_SAVINGS_ACCOUNTS' || r.kind !== 'D' || !appliesBal(r, dep.balance)) continue;
    const p = productByKey.get(r.k);
    if (!p || !consumerOk(p, dep.business) || (dep.brand && p.brand !== dep.brand)) continue;
    const e = per.get(p.key) || { p, k: p.key, base: 0, bonus: 0, bonusInfo: '', intro: null, introTerm: null };
    if (['VARIABLE', 'FLOATING', 'MARKET_LINKED'].includes(r.type)) e.base = Math.max(e.base, r.rate);
    else if ((r.type === 'BONUS' || r.type === 'BUNDLE_BONUS') && r.rate > e.bonus) Object.assign(e, { bonus: r.rate, bonusInfo: r.info || '' });
    else if (r.type === 'INTRODUCTORY' && r.rate > (e.intro ?? 0)) Object.assign(e, { intro: r.rate, introTerm: r.term });
    per.set(p.key, e);
  }
  const rows = [...per.values()]
    .map((e) => ({ ...e, total: e.base + (dep.conditions ? e.bonus : 0) }))
    .filter((e) => e.total > 0 || e.intro)
    .map((e) => ({ ...e, yearly: (dep.balance * e.total) / 100 }));
  markOutliers(rows, 'desc', (r) => r.total);
  table(
    el,
    [
      { key: 'brand', label: 'Provider / account', fmt: (r) => bankCell(r.p) + (r.outlier ? outlierTag : ''), sort: (r) => r.p.brand },
      { key: 'total', label: dep.conditions ? 'Max rate' : 'Base rate', n: true, cls: 'rate', fmt: (r) => pct(r.total), defaultSort: true, defaultDir: 'desc', sort: rateSort((r) => r.total, 'desc') },
      { key: 'base', label: 'Base', n: true, fmt: (r) => pct(r.base), defaultDir: 'desc' },
      { key: 'bonus', label: 'Bonus', n: true, fmt: (r) => (r.bonus ? pct(r.bonus) : '\u2014'), defaultDir: 'desc' },
      { key: 'intro', label: 'Intro offer', n: true, fmt: (r) => (r.intro ? `${pct(r.intro)}${r.introTerm ? ` <span class="small muted">for ${termLabel(r.introTerm)}</span>` : ''}` : '\u2014'), defaultDir: 'desc' },
      { key: 'yearly', label: 'Interest / yr', n: true, fmt: (r) => money(r.yearly), defaultDir: 'desc' },
      { key: 'bonusInfo', label: 'Bonus conditions', fmt: (r) => `<span class="small muted">${esc(r.bonusInfo)}</span>` },
    ],
    rows,
    Object.assign(dep.ts, { highlightTop: true }),
    (r) => openProduct(r.k)
  );
}

// ---------- CARDS & PERSONAL LOANS
const cp = { mode: 'cards', balance: 3000, nofee: false, tailored: true, business: false, brand: '', tc: {}, tp: {} };
renderers.cards = () => {
  const el = $('#tab-cards');
  el.innerHTML = `
    <h2 class="page-title" id="cp-title"></h2>
    <p class="muted" id="cp-intro"></p>
    <div class="filters" id="cp-f">
      <label class="field" id="cp-bal">Typical balance carried<input type="number" data-k="balance" min="0" step="500" /></label>
      <label class="field">Provider<select data-k="brand"><option value="">All providers</option>${brandOptions()}</select></label>
      <label class="check" id="cp-nofee"><input type="checkbox" data-k="nofee" /> $0 annual fee only</label>
      <label class="check" id="cp-tail"><input type="checkbox" data-k="tailored" /> Include tailored</label>
      <label class="check"><input type="checkbox" data-k="business" /> Show business products</label>
    </div><div id="cp-table"></div>`;
  bindFilters($('#cp-f', el), cp, drawCards);
  drawCards();
};
function setCpMode(m) {
  cp.mode = m;
  drawCards();
}
function drawCards() {
  $('#cp-title').textContent = cp.mode === 'pl' ? 'Personal loans' : 'Credit cards';
  $('#cp-intro').textContent = cp.mode === 'pl' ? 'Advertised starting rates. Most personal loans are priced on your profile, so your rate may be higher.' : 'Purchase rates and fees, with an estimate of what a card costs you each year at your balance.';
  $('#cp-bal').style.display = $('#cp-nofee').style.display = cp.mode === 'cards' ? '' : 'none';
  const el = $('#cp-table');
  const cat = cp.mode === 'cards' ? 'CRED_AND_CHRG_CARDS' : 'PERS_LOANS';
  const per = new Map();
  for (const r of D.rates) {
    if (r.cat !== cat || r.kind !== 'L' || !r.comparable) continue;
    const p = productByKey.get(r.k);
    if (!p || !consumerOk(p, cp.business) || (cp.brand && p.brand !== cp.brand) || (p.tailored && !cp.tailored)) continue;
    if (cp.mode === 'cards' && cp.nofee && p.yearlyFees) continue;
    const e = per.get(p.key) || { p, k: p.key, purchase: null, cash: null, fixed: null, variable: null, comp: null };
    const t = r.type;
    if (t === 'PURCHASE') e.purchase = Math.min(e.purchase ?? 99, r.rate);
    else if (t === 'CASH_ADVANCE') e.cash = Math.min(e.cash ?? 99, r.rate);
    else if (t === 'FIXED' && r.rate < (e.fixed ?? 99)) Object.assign(e, { fixed: r.rate, comp: r.comp ?? e.comp });
    else if (t === 'VARIABLE' && r.rate < (e.variable ?? 99)) Object.assign(e, { variable: r.rate, comp: e.comp ?? r.comp });
    per.set(p.key, e);
  }
  const rows = [...per.values()];
  if (cp.mode === 'cards') {
    rows.forEach((r) => (r.cost = r.purchase !== null ? (cp.balance * r.purchase) / 100 + (r.p.yearlyFees || 0) : null));
    return table(
      el,
      [
        { key: 'brand', label: 'Provider / card', fmt: (r) => bankCell(r.p), sort: (r) => r.p.brand },
        { key: 'purchase', label: 'Purchase rate', n: true, cls: 'rate', fmt: (r) => pct(r.purchase) },
        { key: 'cash', label: 'Cash advance', n: true, fmt: (r) => pct(r.cash) },
        { key: 'fee', label: 'Annual fees', n: true, fmt: (r) => money(r.p.yearlyFees), sort: (r) => r.p.yearlyFees },
        { key: 'cost', label: 'Est. cost / yr', n: true, fmt: (r) => money(r.cost), defaultSort: true },
        { key: 'features', label: 'Features', fmt: (r) => featureTags(r.p), sort: () => 0 },
      ],
      rows.filter((r) => r.purchase !== null),
      Object.assign(cp.tc, { highlightTop: true }),
      (r) => openProduct(r.k)
    );
  }
  rows.forEach((r) => (r.best = Math.min(r.fixed ?? 99, r.variable ?? 99)));
  table(
    el,
    [
      { key: 'brand', label: 'Provider / loan', fmt: (r) => bankCell(r.p), sort: (r) => r.p.brand },
      { key: 'best', label: 'From', n: true, cls: 'rate', fmt: (r) => pct(r.best < 99 ? r.best : null), defaultSort: true },
      { key: 'fixed', label: 'Fixed', n: true, fmt: (r) => pct(r.fixed) },
      { key: 'variable', label: 'Variable', n: true, fmt: (r) => pct(r.variable) },
      { key: 'comp', label: 'Comparison', n: true, fmt: (r) => pct(r.comp) },
      { key: 'upfront', label: 'Upfront fees', n: true, fmt: (r) => money(r.p.upfrontFees), sort: (r) => r.p.upfrontFees },
    ],
    rows.filter((r) => r.best < 99),
    Object.assign(cp.tp, { highlightTop: true }),
    (r) => openProduct(r.k)
  );
}

// ---------- ALL PRODUCTS
const ap = { q: '', cat: '', brand: '', t: { sort: 'brand' } };
renderers.all = () => {
  const el = $('#tab-all');
  const cats = [...new Set(D.products.map((p) => p.category))].sort();
  el.innerHTML = `
    <h2 class="page-title">All banking products</h2>
    <p class="muted">Search every product published by every bank, including business and specialist products.</p>
    <div class="filters" id="ap-f">
      <label class="field">Search<input type="search" data-k="q" placeholder="Product, provider or feature\u2026" /></label>
      <label class="field">Category<select data-k="cat"><option value="">All categories</option>${cats.map((c) => `<option value="${esc(c)}">${esc(CAT[c] || c)}</option>`).join('')}</select></label>
      <label class="field">Provider<select data-k="brand"><option value="">All providers</option>${brandOptions()}</select></label>
    </div><div id="ap-table"></div>`;
  bindFilters($('#ap-f', el), ap, drawAll);
  drawAll();
};
function drawAll() {
  const q = ap.q.trim().toLowerCase();
  const rows = D.products.filter(
    (p) => (!ap.cat || p.category === ap.cat) && (!ap.brand || p.brand === ap.brand) && (!q || `${p.brand} ${p.name} ${(p.features || []).join(' ')}`.toLowerCase().includes(q))
  );
  table(
    $('#ap-table'),
    [
      { key: 'brand', label: 'Provider / product', fmt: bankCell },
      { key: 'category', label: 'Category', fmt: (p) => esc(CAT[p.category] || p.category) },
      { key: 'rates', label: 'Rates', n: true, fmt: (p) => (ratesByKey.get(p.key) || []).length, sort: (p) => (ratesByKey.get(p.key) || []).length },
      { key: 'yearlyFees', label: 'Ongoing fees / yr', n: true, fmt: (p) => money(p.yearlyFees) },
      { key: 'features', label: 'Features', fmt: featureTags, sort: (p) => (p.features || []).length },
      { key: 'lastUpdated', label: 'Updated by bank', fmt: (p) => esc(p.lastUpdated ? new Date(p.lastUpdated).toLocaleDateString('en-AU') : '\u2014') },
    ],
    rows,
    ap.t,
    (p) => openProduct(p.key)
  );
}

// ---------- DATA QUALITY REPORT
renderers.quality = () => {
  const el = $('#tab-quality');
  const parts = [EN ? ['energy', EN.quality] : null, D.meta ? ['banking', D.quality] : null].filter(Boolean);
  el.innerHTML = parts.map(([s]) => `<div id="dq-${s}"></div>`).join('');
  for (const [s, Q] of parts) renderQuality($(`#dq-${s}`, el), Q, s, parts.length > 1);
};
function renderQuality(el, Q, sector, multi) {
  const T = dqTotals(Q);
  const q = new Map(T.bs.map((x) => [x.brandId, x]));
  const E = sector === 'energy';
  const brands = E ? T.bs.map((b) => ({ brandId: b.brandId, brand: b.brand, ok: b.ok, plans: b.plans, detailVersions: b.standards?.versions || {} })) : D.brands || [];
  const word = E ? { holder: 'retailer', holders: 'retailers', item: 'plan', items: 'plans', site: 'fact sheets', api: 'retailer feeds responding' } : { holder: 'bank', holders: 'banks', item: 'product', items: 'products', site: 'bank websites', api: 'product APIs responding' };
  const failing = brands.filter((b) => !b.ok);
  const cds = T.Q.cds;
  el.innerHTML = `
    <h2 class="page-title">${multi ? (E ? 'Energy data quality' : 'Banking data quality') : 'Data quality'}</h2>
    <p class="muted dq-lede">${E ? `Every morning each retailer's published plans are checked three ways: against the Consumer Data Standards${cds ? ` (version ${esc(cds.spec)}, plan detail v${cds.detail})` : ''}, for plausible prices and working links, and against the plan fact sheets we find on each retailer's own website, a rotating sample each day.` : `Every morning each bank's published product data is checked three ways: against the Consumer Data Standards${cds ? ` (version ${esc(cds.spec)}, product detail v${cds.detail})` : ''}, for links that are broken or misleading, and against the rates and fees on the bank's own web pages and PDFs.`}</p>
    <div class="stats">
      <div class="stat"><div class="v">${brands.length - failing.length}/${brands.length}</div><div class="l">${word.api}</div></div>
      <div class="stat"><div class="v">${T.std.checked ? pctOf(T.std.checked - T.std.withIssues, T.std.checked) : '\u2014'}</div><div class="l">${word.items} with no standards issues</div></div>
      <div class="stat"><div class="v">${T.hasWeb ? pctOf(T.web.linksOk, T.web.linksChecked) : '\u2014'}</div><div class="l">${word.item} links working${T.hasWeb ? ` (${T.web.linksChecked.toLocaleString('en-AU')} checked)` : ''}</div></div>
      <div class="stat"><div class="v">${T.hasWeb ? pctOf(T.web.ratesFound, T.web.ratesChecked) : '\u2014'}</div><div class="l">${E ? 'prices confirmed on fact sheets' : 'rates confirmed on bank websites'}</div></div>
      ${E ? `<div class="stat"><div class="v">${(T.web.plansCovered || 0).toLocaleString('en-AU')}</div><div class="l">plans with a fact sheet found on the retailer's website</div></div>` : `<div class="stat"><div class="v">${T.hasWeb ? pctOf(T.web.feesFound, T.web.feesChecked) : '\u2014'}</div><div class="l">fees confirmed on bank websites</div></div>`}
    </div>
    ${T.hasWeb ? `<p class="small muted dq-note">Read ${T.web.pagesRead.toLocaleString('en-AU')} web pages and ${T.web.pdfsRead.toLocaleString('en-AU')} PDFs. ${T.web.linksBlocked || T.web.linksRobots ? `${plural(T.web.linksBlocked, 'page')} blocked automated checks and ${plural(T.web.linksRobots, 'page')} ${T.web.linksRobots === 1 ? 'was' : 'were'} excluded by robots.txt; those ${word.items} are marked as not checked rather than wrong.` : ''}</p>` : ''}
    <div id="dq-table"></div>
    <div class="dq-help">
      <h3>How to read this</h3>
      <p>Each finding is one kind of problem in one field for one ${word.holder}. A problem repeated across many ${word.items} counts once, with the number of ${word.items} it affects shown alongside. Severity runs from 1 (critical) to 5 (cosmetic):</p>
      <div class="level-legend">${[1, 2, 3, 4, 5, 0].map((l) => `<p>${sevBadge(l)} ${esc((T.Q.levels || DEFAULT_LEVELS)[l]?.help || '')}</p>`).join('')}</div>
      <p class="muted small">Breaking the data standard isn't the same as breaking the law, and most findings here don't change what anyone pays. ${E ? 'Energy plan data is published through the Consumer Data Right by the Australian Energy Regulator (and Victoria\'s energy department) from what retailers submit, so a problem shared by many retailers may come from how the data is published rather than from each retailer.' : ''}</p>
      <p class="muted small">"Not found" means the exact figure didn't appear on the pages or PDFs linked from that ${word.item}. Pages that load rates with JavaScript, or round them differently, can cause this, so check the source before concluding a figure is wrong.</p>
    </div>`;
  const rows = brands.map((b) => {
    const x = q.get(b.brandId) || {};
    const cat = x.byCategory || {};
    const L = levelsOf(x);
    return { ...b, x, problems: L[1] * 1e8 + L[2] * 1e6 + L[3] * 1e4 + L[4] * 100 + L[5], std: cat.standards || 0, acc: cat.accuracy || 0, links: cat.links || 0, webPct: x.web?.ratesChecked ? x.web.ratesFound / x.web.ratesChecked : null };
  });
  const cnt = (n) => (n ? `<b>${n.toLocaleString('en-AU')}</b>` : '<span class="muted">0</span>');
  table(
    $('#dq-table', el),
    [
      { key: 'brand', label: E ? 'Retailer' : 'Bank or brand', fmt: (b) => `<div class="bank">${esc(b.brand)}</div><div class="prod">${b.ok ? `${E ? `${b.plans ?? 0} plans, ` : `API list v${esc(b.listVersion ?? '\u2014')}, `}detail ${Object.entries(b.detailVersions || {}).map(([v, n]) => `v${esc(v)}\u00d7${n}`).join(', ') || '\u2014'}` : `<span class="status-fail">${E ? 'Feed' : 'API'} not responding</span>`}</div>` },
      { key: 'std', label: 'Standards', n: true, fmt: (b) => cnt(b.std) },
      { key: 'acc', label: 'Accuracy', n: true, fmt: (b) => cnt(b.acc) },
      { key: 'links', label: 'Links', n: true, fmt: (b) => cnt(b.links) },
      { key: 'webPct', label: E ? 'Prices on fact sheets' : 'Rates on website', n: true, fmt: (b) => (b.webPct === null ? '<span class="muted">not checked</span>' : `${pctOf(b.x.web.ratesFound, b.x.web.ratesChecked)} <span class="small muted">(${b.x.web.ratesFound}/${b.x.web.ratesChecked})</span>`), defaultDir: 'asc' },
      { key: 'problems', label: 'Findings by severity', n: true, fmt: (b) => levelChips(b.x), defaultSort: true, defaultDir: 'desc' },
    ],
    rows,
    { sort: 'problems', dir: 'desc' },
    (b) => openBrandReport(b.brandId, sector)
  );
}

// One bank's or retailer's full report, in the side panel
const dqCache = new Map();
async function openBrandReport(brandId, sector = 'banking') {
  const T = dqTotals(sector === 'energy' ? EN?.quality : D.quality);
  const x = T.bs.find((b) => b.brandId === brandId);
  const b = sector === 'energy' ? { brand: x?.brand, baseUri: '' } : (D.brands || []).find((y) => y.brandId === brandId);
  const drawer = $('#drawer');
  const body = $('#drawer-body');
  drawer.hidden = false;
  document.body.style.overflow = 'hidden';
  body.innerHTML = `<h2 id="drawer-title">${esc(b?.brand || x?.brand || '')}</h2><div class="empty">Loading the report\u2026</div>`;
  let f = { issues: [], links: [], checks: [], codes: {} };
  if (x?.file) {
    if (!dqCache.has(x.file)) dqCache.set(x.file, fetch(DATA + x.file).then((r) => r.json()).catch(() => null));
    f = (await dqCache.get(x.file)) || f;
  }
  const cats = T.Q.categories?.length ? T.Q.categories : [{ id: 'accuracy', label: 'Issues' }];
  const link = (u) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener nofollow">${esc(u.replace(/^https?:\/\//, '').slice(0, 90))}</a>` : esc(u ?? ''));
  const cell = (v) => (typeof v === 'string' && /^https?:\/\//.test(v) ? link(v) : `<code>${esc(v ?? '')}</code>`);
  const w = x?.web;
  const item = sector === 'energy' ? 'plan' : 'product';
  const groupsHtml = cats
    .map((c) => {
      const groups = (x?.issues || []).filter((g) => g.category === c.id);
      if (!groups.length) return '';
      return `<h4>${esc(c.label)}</h4>${groups
        .map((g) => {
          const items = f.issues.filter((i) => (g.gk && i.gk ? i.gk === g.gk : i.code === g.code)).slice(0, 150);
          return `<details class="dq-group"><summary>${sevBadge(levelOfGroup(g))}<span class="g-label">${esc(g.label)}${g.field ? `<span class="g-field">${esc(g.field)}</span>` : ''}</span><span class="g-count">${g.products ? plural(g.products, item) : plural(g.count, 'instance')}</span></summary>
            <div class="table-wrap"><table><thead><tr><th>${item === 'plan' ? 'Plan' : 'Product'}</th><th>Field</th><th>Value</th><th>Detail</th></tr></thead><tbody>${items
              .map((i) => `<tr><td>${esc(i.product || '\u2014')}</td><td>${i.field ? `<code>${esc(i.field)}</code>` : ''}</td><td>${i.value !== null && i.value !== undefined ? cell(i.value) : ''}</td><td class="small">${typeof i.detail === 'string' && /^https?:/.test(i.detail) ? link(i.detail) : esc(i.detail || '')}</td></tr>`)
              .join('')}</tbody></table></div>${g.count > items.length ? `<p class="small muted">Showing ${items.length} of ${g.count}.</p>` : ''}</details>`;
        })
        .join('')}`;
    })
    .join('');
  const mismatches = (f.checks || []).filter((c) => c.status === 'mismatch');
  const badLinks = (f.links || []).filter((l) => l.status !== 'ok');
  const STATUS = { broken: 'Broken', invalid: 'Invalid URL', homepage: 'Goes to homepage', blocked: 'Blocked our check', robots: 'Excluded by robots.txt', skipped: 'Not checked (time limit)', unchecked: 'Couldn’t check from our server' };
  body.innerHTML = `
    <h2 id="drawer-title">${esc(b?.brand || x?.brand || '')}</h2>
    <div class="muted">${esc(b?.baseUri || '')}</div>
    <div class="dq-chips">${[1, 2, 3, 4, 5].filter((l) => levelsOf(x)[l]).map((l) => `<span class="sev-n l${l}">${plural(levelsOf(x)[l], `${LEVEL_NAMES[l].toLowerCase()} finding`)}</span>`).join('')}${x?.infos ? `<span class="sev-n l0">${plural(x.infos, 'note')}</span>` : ''}${!Object.values(levelsOf(x)).some(Boolean) && !x?.infos ? '<span class="status-ok">No issues found</span>' : ''}</div>
    ${x?.findings !== undefined ? `<p class="small muted">${plural(x.findings, 'finding')}${x.affected ? `, affecting ${plural(x.affected, item)}` : ''}. A problem repeated across ${item}s counts once.</p>` : ''}
    <dl class="kv">
      <dt>Standards</dt><dd>${x?.standards ? `${x.standards.checked - x.standards.withIssues} of ${x.standards.checked} ${sector === 'energy' ? 'plans' : 'products'} with no issues` : '\u2014'}</dd>
      ${sector === 'energy' ? `<dt>Website</dt><dd>${w?.website ? link(w.website) : 'Not identified'}${w?.website ? ` · fact sheets found for ${(w.plansCovered || 0).toLocaleString('en-AU')} of ${(x?.plans || 0).toLocaleString('en-AU')} plans so far` : ''}</dd>` : ''}
      <dt>${sector === 'energy' ? 'Fact sheets' : 'Website match'}</dt><dd>${w ? (sector === 'energy' ? (w.ratesChecked ? `${w.ratesFound} of ${w.ratesChecked} prices match the fact sheets of the ${w.productsChecked} plans checked today` : 'No plans checked today') : `${w.ratesFound} of ${w.ratesChecked} rates and ${w.feesFound} of ${w.feesChecked} fees found on the bank's pages`) : 'Not checked'}</dd>
      <dt>Pages read</dt><dd>${w ? `${w.pagesRead} web pages, ${w.pdfsRead} PDFs` : '\u2014'}</dd>
      <dt>Links</dt><dd>${w ? `${w.linksOk} of ${w.urls} working${w.linksBroken ? `, ${w.linksBroken} broken` : ''}${w.linksHomepage ? `, ${w.linksHomepage} to homepage` : ''}${w.linksBlocked ? `, ${w.linksBlocked} blocked` : ''}` : '\u2014'}</dd>
    </dl>
    ${mismatches.length ? `<h4>${sector === 'energy' ? 'Prices not found on the fact sheet' : 'Figures not found on the bank’s pages'}</h4>${mismatches
      .slice(0, 60)
      .map((c) => `<div class="mm"><div class="mm-head"><b>${esc(c.product)}</b></div><ul>${c.items
        .filter((i) => !i.found)
        .map((i) => {
          const fv = (v) => (i.kind === 'cents' ? v.toFixed(2) + 'c' : i.kind === 'fee' ? '$' + v.toFixed(2) : v.toFixed(2) + '%');
          return `<li>${esc(i.what)}: CDR says <b>${fv(i.value)}</b>${i.kind === 'cents' ? ' incl. GST' : ''}${i.closest?.length ? `; nearest on the page: ${i.closest.map(fv).join(', ')}` : ''}</li>`;
        })
        .join('')}</ul><div class="small muted">Checked: ${c.sources.map((s) => link(s.url)).join(', ')}</div></div>`)
      .join('')}` : ''}
    ${groupsHtml || '<p class="muted">Nothing to report.</p>'}
    ${badLinks.length ? `<h4>Links that need attention</h4><div class="table-wrap"><table><thead><tr><th>Status</th><th>Link</th><th>Used by</th></tr></thead><tbody>${badLinks
      .slice(0, 200)
      .map((l) => `<tr><td>${esc(STATUS[l.status] || l.status)}${l.httpStatus ? ` <span class="small muted">(HTTP ${l.httpStatus})</span>` : ''}</td><td class="small">${link(l.url)}${l.status === 'homepage' && l.finalUrl ? `<div class="muted">ends at ${link(l.finalUrl)}</div>` : ''}</td><td class="small">${esc(l.products.slice(0, 3).join(', '))}${l.products.length > 3 ? ` and ${l.products.length - 3} more` : ''}</td></tr>`)
      .join('')}</tbody></table></div>` : ''}
    ${f.truncated ? `<p class="small muted">This ${sector === 'energy' ? 'retailer' : 'bank'} has a very large number of findings; the first 1,200 are listed here, and the counts above include them all.</p>` : ''}`;
}

// ---------- ABOUT
renderers.about = () => {
  const m = D.meta;
  const em = EN?.meta;
  const when = new Date((m || em).generatedAt).toLocaleString('en-AU');
  $('#tab-about').innerHTML = `<div class="about">
    <h2 class="page-title">Methodology</h2>
    <p>OpenCompare reads data that Australian businesses must publish under the <a href="https://www.cdr.gov.au/" target="_blank" rel="noopener">Consumer Data Right</a>, following the <a href="https://consumerdatastandardsaustralia.github.io/standards/" target="_blank" rel="noopener">Consumer Data Standards</a>. The data is refreshed every morning.</p>
    ${em ? `<h2>Energy</h2>
    <p>Each retailer's generic plans are read from the Australian Energy Regulator's Energy Made Easy service (<code>GET /energy/plans</code> and <code>GET /energy/plans/{planId}</code>). Plan details are only re-read when a plan's <code>lastUpdated</code> changes.</p>
    <ul>
      <li>Prices are published excluding GST; every estimate adds 10% GST. Solar feed-in credits are shown as published.</li>
      <li>Annual cost = daily supply charges + usage (stepped and seasonal rates applied as published) + ongoing membership fees − guaranteed discounts, plus GST, minus any solar feed-in credit.</li>
      <li>Time-of-use usage is split across peak, shoulder and off-peak windows using a typical household pattern (more use in the morning and evening). Your own pattern will differ.</li>
      <li>Conditional discounts (pay on time, direct debit) are only included if you tick the box. Demand charges aren't estimated; demand plans are hidden unless you ask for them.</li>
      <li>Rankings use ${(em.defaults?.E?.usage || 4000).toLocaleString('en-AU')} kWh of electricity or ${(em.defaults?.G?.usage || 20000).toLocaleString('en-AU')} MJ of gas a year, residential market plans, on the network with the most plans in each state. Plans limited to particular groups (such as seniors or club members) and plans with data errors are left out of rankings.</li>
      <li>Gas rates without a stated unit are treated as per MJ.</li>
      <li>Coverage: NSW, the ACT, Victoria, Queensland, South Australia and Tasmania. Western Australia and the Northern Territory aren't in the National Electricity Market, so their plans aren't published under the Consumer Data Right.</li>
      <li>Fact sheets: most plans don't link to their fact sheet in the CDR data, so we search each retailer's website (its sitemaps, fact-sheet and pricing pages, and the PDFs they link to) and match documents to plans by plan ID. Each day a sample of plans is checked: supply charges and usage rates in the CDR data must appear on the plan's own fact sheet, including or excluding GST. Differences are reported as data-quality warnings.</li>
    </ul>
    <dl class="kv"><dt>Plans</dt><dd>${em.plans.toLocaleString('en-AU')} from ${em.retailers} retailers (${em.feedsOk} of ${em.feeds} feeds responding)</dd>
    <dt>Plan detail</dt><dd>${em.detail ? `${em.detail.fetched} read today, ${em.detail.reused} unchanged${em.detail.deferred ? `, ${em.detail.deferred} deferred to tomorrow` : ''}` : '—'}</dd>
    <dt>Standard</dt><dd>${em.cds ? `CDS ${esc(em.cds.spec)}, plan detail v${em.cds.detail}` : '—'}</dd></dl>` : ''}
    ${m ? `<h2>Banking</h2>
    <p>Every banking brand on the CDR Register is read through its Product Reference APIs (<code>GET /banking/products</code> and <code>GET /banking/products/{productId}</code>). Lending rates are compared by loan purpose, repayment type, fixed term and LVR band; deposit rates by term and balance.</p>
    <ul>
      <li>Headline home-loan comparisons use an LVR of ${m.scenarios.homeLoanLvr}%; deposit comparisons a $${m.scenarios.depositBalance.toLocaleString('en-AU')} balance.</li>
      <li>Tailored, business, staff-only and special-purpose products are left out of consumer rankings, and outlier rates are set aside.</li>
    </ul>` : ''}
    <h2>Run details</h2>
    <dl class="kv"><dt>Last refresh</dt><dd>${esc(when)}</dd>
    <dt>API calls</dt><dd>${((m?.http?.requests || 0) + (em?.http?.requests || 0)).toLocaleString()}</dd>
    ${em?.history ? `<dt>Price history</dt><dd>Recorded daily since ${esc(new Date(em.history.since + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))}: ${em.history.plans.toLocaleString('en-AU')} plans tracked; in the last 30 days ${em.history.last30.price.toLocaleString('en-AU')} price changes, ${em.history.last30.new.toLocaleString('en-AU')} new plans and ${em.history.last30.gone.toLocaleString('en-AU')} withdrawn</dd>` : ''}</dl>
    <p class="small muted">General information only${m ? ', not financial advice' : ', not a recommendation for your circumstances'}.</p></div>`;
};

// ---------- PRODUCT DRAWER
const detailCache = new Map();
async function openProduct(key) {
  const p = productByKey.get(key);
  if (!p) return;
  const drawer = $('#drawer');
  const body = $('#drawer-body');
  drawer.hidden = false;
  document.body.style.overflow = 'hidden';
  const b = (D.brands || []).find((x) => x.brandId === p.brandId);
  body.innerHTML = `<h2 id="drawer-title">${esc(p.name)}</h2><div class="muted">${esc(p.brand)}, ${esc((CAT[p.category] || p.category).toLowerCase())}</div><div class="empty">Loading\u2026</div>`;
  let det = {};
  if (b?.detailFile) {
    if (!detailCache.has(b.detailFile)) detailCache.set(b.detailFile, fetch(DATA + b.detailFile).then((r) => r.json()).catch(() => ({})));
    det = (await detailCache.get(b.detailFile))[key] || {};
  }
  const rates = (ratesByKey.get(key) || []).slice().sort((a, b) => (a.purpose || '').localeCompare(b.purpose || '') || (a.repay || '').localeCompare(b.repay || '') || a.type.localeCompare(b.type) || (a.term ?? 0) - (b.term ?? 0) || (a.lvrMax ?? 0) - (b.lvrMax ?? 0));
  const isLoan = rates.some((r) => r.kind === 'L');
  const apply = safeUrl(p.uri) || safeUrl(det.overviewUri);
  body.innerHTML = `
    <h2 id="drawer-title">${esc(p.name)}</h2>
    <div class="muted">${esc(p.brand)}, ${esc((CAT[p.category] || p.category).toLowerCase())}${p.tailored ? ' <span class="tag warn">Tailored: your rate may differ</span>' : ''}</div>
    ${det.description ? `<p>${esc(det.description)}</p>` : ''}
    <div>${featureTags(p)}${(p.features || []).filter((f) => !FEATURE[f]).map((f) => `<span class="tag">${esc(f.replace(/_/g, ' ').toLowerCase())}</span>`).join('')}</div>
    ${apply ? `<a class="btn" href="${esc(apply)}" target="_blank" rel="noopener nofollow">View on ${esc(p.brand)} site \u2197</a>` : ''}
    <h4>Rates (${rates.length})</h4>
    ${rates.length ? `<div class="table-wrap"><table><thead><tr><th>Type</th>${isLoan ? '<th>Purpose</th><th>Repayment</th><th>LVR</th>' : '<th>Balance</th>'}<th>Term</th><th class="n">Rate</th>${isLoan ? '<th class="n">Comp.</th>' : ''}</tr></thead><tbody>${rates
      .map((r) => `<tr><td>${esc(r.type.toLowerCase().replace(/_/g, ' '))}${r.info ? `<div class="small muted">${esc(r.info)}</div>` : ''}</td>${isLoan ? `<td>${esc(r.kind === 'L' ? LABEL[r.purpose] || r.purpose : '')}</td><td>${esc(r.kind === 'L' ? LABEL[r.repay] || r.repay : '')}</td><td>${lvrText(r)}</td>` : `<td>${r.balMin !== null || r.balMax !== null ? `${money(r.balMin ?? 0)}${r.balMax ? `\u2013${money(r.balMax)}` : '+'}` : 'Any'}</td>`}<td>${esc(termLabel(r.term))}</td><td class="n rate">${pct(r.rate)}</td>${isLoan ? `<td class="n">${pct(r.comp)}</td>` : ''}</tr>`)
      .join('')}</tbody></table></div>` : '<p class="muted">No rates published for this product.</p>'}
    <h4>Fees</h4>
    ${det.fees?.length ? `<div class="table-wrap"><table><thead><tr><th>Fee</th><th>Type</th><th class="n">Amount</th></tr></thead><tbody>${det.fees
      .map((f) => `<tr><td>${esc(f.name)}${f.info ? `<div class="small muted">${esc(f.info)}</div>` : ''}</td><td>${esc((f.type || '').toLowerCase())}${f.freqMonths ? `, every ${esc(termLabel(f.freqMonths))}` : ''}</td><td class="n">${f.amount !== null ? money(f.amount, 2) : f.rate !== null ? pct(f.rate) : '\u2014'}</td></tr>`)
      .join('')}</tbody></table></div>` : '<p class="muted">No fees published.</p>'}
    ${det.eligibility?.length ? `<h4>Eligibility</h4><dl class="kv">${det.eligibility.map((e) => `<dt>${esc((e.type || '').replace(/_/g, ' ').toLowerCase())}</dt><dd>${esc([e.value, e.info].filter(Boolean).join(' \u2014 ') || '\u2014')}</dd>`).join('')}</dl>` : ''}
    ${det.constraints?.length ? `<h4>Constraints</h4><dl class="kv">${det.constraints.map((c) => `<dt>${esc((c.type || '').replace(/_/g, ' ').toLowerCase())}</dt><dd>${esc([c.value, c.info].filter(Boolean).join(' \u2014 ') || '\u2014')}</dd>`).join('')}</dl>` : ''}
    <h4>Source</h4>
    <dl class="kv"><dt>Product ID</dt><dd><code class="small">${esc(p.productId)}</code></dd><dt>Last updated</dt><dd>${esc(p.lastUpdated ? new Date(p.lastUpdated).toLocaleString('en-AU') : '\u2014')}</dd>${safeUrl(det.feesUri) ? `<dt>Fees &amp; pricing</dt><dd><a href="${esc(det.feesUri)}" target="_blank" rel="noopener nofollow">Provider page \u2197</a></dd>` : ''}</dl>`;
}
function closeDrawer() {
  $('#drawer').hidden = true;
  document.body.style.overflow = '';
}
$('#drawer').addEventListener('click', (e) => e.target.closest('[data-close]') && closeDrawer());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

load();
