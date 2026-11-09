// OpenCompare: energy pages (home, plan finder, retailers, insights). Uses the shared cost model.
import { signupBox } from './signup.js';
import { annualCost, headline, availableAt, postcodeState, DEFAULTS, GST } from './energy-cost.js';

const STATE_NAME = { NSW: 'NSW', VIC: 'Victoria', QLD: 'Queensland', SA: 'South Australia', ACT: 'ACT', TAS: 'Tasmania', WA: 'WA', NT: 'NT', OTHER: 'Other' };
const RESTRICTED = { SENIOR_CARD: 'Seniors card', SPORT_CLUB_MEMBER: 'Club members', ORG_MEMBER: 'Members only', LOYALTY_MEMBER: 'Loyalty members', GROUP_BUY_MEMBER: 'Group buy', THIRD_PARTY_ONLY: 'Via a third party', REQ_EQUIP_SUPPLIER: 'Equipment purchase required', CONTINGENT_PLAN: 'Needs another plan', EXISTING_BATTERY: 'Battery owners', EXISTING_POOL: 'Pool owners', EXISTING_SOLAR: 'Solar owners', EXISTING_SMART_METER: 'Smart meter', NEW_CUSTOMER: 'New customers', EXISTING_CUST: 'Existing customers', ONLINE_ONLY: 'Online only', SPECIFIC_LOCATION: 'Specific location', MINIMUM_USAGE: 'Minimum usage', SMALL_BUSINESS: 'Small business' };
const DAYS_ALL = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export function setupEnergy(ctx) {
  const { $, esc, money, table, bindFilters, sevBadge, pctOf, dqTotals, DATA, renderers, openDrawer, go } = ctx;
  const EN = ctx.EN; // { meta, insights, boards, quality, changes, retailers }
  const cache = new Map();
  const byId = new Map();
  const cents = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)}c`);
  const dollars = (n) => money(Math.round(n));

  async function plansFor(state) {
    const s = EN.meta.states?.[state];
    if (!s) return [];
    if (!cache.has(state)) cache.set(state, fetch(DATA + s.file).then((r) => r.json()).catch(() => []));
    const list = await cache.get(state);
    for (const p of list) byId.set(p.id, p);
    return list;
  }
  async function findPlan(id) {
    if (byId.has(id)) return byId.get(id);
    for (const s of Object.keys(EN.meta.states || {})) {
      await plansFor(s);
      if (byId.has(id)) return byId.get(id);
    }
    return null;
  }
  const fuelOf = (p, fuel) => (fuel === 'G' ? p.g : p.e);
  const tags = (p, c) =>
    [p.t !== 'MARKET' ? '<span class="tag">Standing offer</span>' : '', c?.fx ? '<span class="tag good">Fixed price</span>' : '', c?.tp?.some((t) => t.kind === 'tou') ? '<span class="tag">Time of use</span>' : '', c?.tp?.some((t) => t.kind === 'demand') ? '<span class="tag warn">Demand charges</span>' : '', ...(c?.elig || []).filter((e) => RESTRICTED[e.type]).map((e) => `<span class="tag warn">${esc(RESTRICTED[e.type])}</span>`), p.bad ? '<span class="tag warn" title="This plan has data errors, such as prices published in cents. Check the fact sheet.">Check details</span>' : ''].join('');

  // WA and the NT aren't in the National Electricity Market, so their plans aren't published under the CDR
  const ext = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  function notCovered(state, fuel) {
    const where = state === 'WA' ? 'Western Australia' : 'the Northern Territory';
    const head = `<p><b>${fuel === 'G' ? 'Gas' : 'Electricity'} plans in ${where} aren't published under the Consumer Data Right,</b> so we can't compare them here. The Consumer Data Right for energy covers the states and territory connected to the National Electricity Market: NSW, the ACT, Victoria, Queensland, South Australia and Tasmania.</p>`;
    if (fuel === 'G') return `${head}<p>Check gas retailers' websites directly for their current prices.</p>`;
    return state === 'WA'
      ? `${head}<p>Households are supplied by ${ext('https://www.synergy.net.au', 'Synergy')} (Perth and the South West) or ${ext('https://www.horizonpower.com.au', 'Horizon Power')} (regional WA), at prices set by the WA Government.</p>`
      : `${head}<p>Most households are supplied by ${ext('https://www.jacanaenergy.com.au', 'Jacana Energy')}, at prices set by the NT Government.</p>`;
  }

  // ---------- HOME
  let homeFuel = 'E';
  let homeBoard = null;
  function renderHome(el) {
    const m = EN.meta;
    const featured = ['cheapest-E-NSW', 'cheapest-E-VIC', 'cheapest-E-QLD', 'standing-E-NSW', 'standing-E-VIC', 'fit-best', 'cheapest-G-VIC', 'fixed-share']
      .map((id) => EN.insights.find((i) => i.id === id))
      .filter(Boolean);
    const extra = EN.insights.filter((i) => !featured.includes(i) && i.id !== 'dq' && i.id !== 'changes');
    const pick = [...featured, ...extra].slice(0, 4);
    const run = EN.changes?.runs?.[0];
    const T = dqTotals(EN.quality);
    el.innerHTML = `
      <section class="hero" id="sec-hero">
        <h2 class="display">${m.retailers} energy retailers.<br />One honest comparison.</h2>
        <p class="lede">Every morning we read every retailer's electricity and gas plans from the official Energy Made Easy data and estimate what each would cost you. Nobody pays to be listed or ranked.</p>
        <form class="pc-start" id="pc-start">
          <label class="field">Your postcode<input type="text" inputmode="numeric" pattern="\\d{4}" maxlength="4" placeholder="e.g. 3000" id="pc-start-input" required /></label>
          <button class="btn-primary" type="submit">Compare electricity</button>
          <a class="btn-ghost" href="#gas">Compare gas</a>
        </form>
        ${EN.boards.length ? `<div class="board-card">
          <div class="board-bar"><span class="board-title">Cheapest plans today</span><span class="board-live"><span class="live-dot"></span>From this morning's data</span></div>
          <div class="board-switch"><div class="seg" id="home-fuel"><button data-f="E">Electricity</button><button data-f="G">Gas</button></div></div>
          <div class="seg-tabs" role="tablist" aria-label="State" id="home-states"></div>
          <div id="home-board"></div>
        </div>` : ''}
      </section>

      <section class="section" id="sec-how">
        <h2 class="section-title">How it works</h2>
        <p class="section-lede">Every energy retailer has to publish its plans through the Consumer Data Right. We turn that data into an estimate of what you'd actually pay.</p>
        <ol class="steps">
          <li class="step"><span class="step-n">1</span><h3>Read every retailer's plans</h3><p>Each morning we read ${m.plans.toLocaleString('en-AU')} current plans from ${m.retailers} retailers, published through Energy Made Easy, the energy regulator's service.</p></li>
          <li class="step"><span class="step-n">2</span><h3>Match them to your address</h3><p>Plans are filtered to your postcode and electricity or gas network, then priced on your usage, including supply charges, usage rates, guaranteed discounts, fees, GST and any solar feed-in.</p></li>
          <li class="step"><span class="step-n">3</span><h3>Show what's best and what changed</h3><p>We rank the cheapest plans, compare them with standing offers, and flag every price that moved since the previous morning.</p></li>
        </ol>
      </section>

      <section class="section" id="sec-insights">
        <h2 class="section-title">What the data shows today</h2>
        <p class="section-lede">Worked out automatically from this morning's plans, for a typical home using ${DEFAULTS.E.usage.toLocaleString('en-AU')} kWh of electricity or ${DEFAULTS.G.usage.toLocaleString('en-AU')} MJ of gas a year.</p>
        <div class="insight-grid">${pick.map((i) => `<article class="insight"><h3>${esc(i.headline)}</h3><p>${esc(i.detail)}</p></article>`).join('')}</div>
        <div class="changes-box">
          <h3>Changed since the last check</h3>
          ${run?.count
            ? `<p class="muted">${run.count.toLocaleString('en-AU')} plan${run.count > 1 ? 's' : ''} changed price: ${run.changes.filter((c) => c.delta > 0).length} went up and ${run.changes.filter((c) => c.delta < 0).length} went down.</p>
               <ul class="changes">${run.changes.slice(0, 4).map((c) => `<li><button class="change-row" data-plan="${esc(c.id)}"><span><b>${esc(c.retailer)}</b> ${esc(c.plan)}<span class="c-what">${c.fuel === 'E' ? 'Electricity' : 'Gas'}, ${esc(c.states.join(', '))}, typical annual cost</span></span><span class="c-fig">${dollars(c.from)} to <b class="${c.delta > 0 ? 'up' : 'down'}">${dollars(c.to)}</b></span></button></li>`).join('')}</ul>`
            : '<p class="muted">No plan prices changed since the previous check.</p>'}
        </div>
        <p class="section-foot"><a class="btn-ghost" href="#all-insights">See all insights and rankings</a></p>
      </section>

      <section class="section" id="sec-quality">
        <h2 class="section-title">How good is the published data?</h2>
        <p class="section-lede">Retailers must keep their published plan data accurate. Each morning we check it against the Consumer Data Standards, test the links, and compare prices with the retailer's own plan fact sheets.</p>
        <div class="stat-grid">
          <div class="bigstat accent"><span class="bs-n">${T.levels[1] + T.levels[2]}</span><span class="bs-l">critical or major findings this morning${T.findings ? `, plus ${T.levels[3] + T.levels[4]} moderate or minor and ${T.levels[5]} cosmetic, across ${T.withFindings} of ${T.bs.length} retailers` : ''}</span></div>
          <div class="bigstat"><span class="bs-n">${T.std.checked ? pctOf(T.std.checked - T.std.withIssues, T.std.checked) : '—'}</span><span class="bs-l">of plans meet the data standard with no issues</span></div>
          <div class="bigstat"><span class="bs-n">${T.hasWeb ? pctOf(T.web.ratesFound, T.web.ratesChecked) : '—'}</span><span class="bs-l">of prices checked also appear on the retailer's fact sheet${T.hasWeb ? ` (${T.web.ratesFound} of ${T.web.ratesChecked})` : ''}</span></div>
          <div class="bigstat"><span class="bs-n">${T.hasWeb ? T.web.linksBroken : '—'}</span><span class="bs-l">broken plan links in today's sample</span></div>
          <div class="bigstat"><span class="bs-n">${m.feedsOk}<small>/${m.feeds}</small></span><span class="bs-l">retailer feeds responding</span></div>
        </div>
        ${T.top.length ? `<h3 class="sub-title">Most serious findings</h3><ul class="issue-rows">${T.top.slice(0, 5).map((i) => `<li><span>${sevBadge(i.level)} ${esc(i.label)}${i.field ? ` <code class="small">${esc(i.field.split('.').slice(-2).join('.'))}</code>` : ''}</span><span class="muted">${i.brands} retailer${i.brands > 1 ? 's' : ''}, ${i.plans.toLocaleString('en-AU')} plan${i.plans === 1 ? '' : 's'}</span></li>`).join('')}</ul>` : ''}
        <p class="section-foot"><a class="btn-ghost" href="#data-quality">Open the full data-quality report</a></p>
      </section>

      ${(() => {
        const b = ctx.brief?.();
        const box = signupBox(ctx.site?.(), '');
        if (!b && !box) return '';
        return `<section class="section" id="sec-brief">
        <h2 class="section-title">This week in energy prices</h2>
        ${b ? `<p class="section-lede"><a href="brief/${esc(b.date)}/"><b>${esc(b.title)}</b></a></p><p>${esc(b.lead)}</p><p class="section-foot"><a class="btn-ghost" href="brief/${esc(b.date)}/">Read the weekly brief</a> <a class="textbtn" href="brief/">All briefs</a></p>` : ''}
        ${box}
      </section>`;
      })()}

      <section class="section" id="sec-about">
        <h2 class="section-title">About</h2>
        <p class="section-lede">OpenCompare is independent. It isn't owned by or affiliated with any ${ctx.banking ? 'energy retailer or bank' : 'energy retailer'}, and nobody can pay to change where they appear.</p>
        <div class="faq">
          <details><summary>Where does the data come from?</summary><p>From the generic plan data every retailer publishes under the Consumer Data Right, served by the Australian Energy Regulator's Energy Made Easy service. We don't use paid feeds or commissions.</p></details>
          <details><summary>How are the costs worked out?</summary><p>For your usage we add up daily supply charges, usage rates (including stepped and time-of-use rates, using a typical household pattern), ongoing fees and guaranteed discounts, then add GST and subtract any solar feed-in credit. Conditional discounts, like paying on time, are only included if you tick the box.</p></details>
          <details><summary>Why might my bill be different?</summary><p>Your real usage pattern, meter type, concessions and the retailer's terms all affect the bill. Use the estimate to shortlist, then check the plan's fact sheet (Basic Plan Information Document) before switching.</p></details>
          <details><summary>Which states are covered?</summary><p>New South Wales, the ACT, Victoria, Queensland, South Australia and Tasmania: the places connected to the National Electricity Market, where retailers' plans are published under the Consumer Data Right. Western Australia and the Northern Territory have their own power systems and aren't covered; most households there are supplied by government-owned retailers at prices set by their governments.</p></details>
          <details><summary>How often is it updated?</summary><p>Every morning. The time of the latest update is shown at the top of every page.</p></details>
          <details><summary>Should I switch based on this?</summary><p>Use it to shortlist. It's general information based on each retailer's published prices and the usage you enter, not a recommendation for your circumstances. Before switching, read the plan's fact sheet and compare it with your current bill, which also tells you whether your retailer has a better offer for you.</p></details>
        </div>
        <p class="section-foot"><a class="btn-ghost" href="#methodology">Read the full methodology</a></p>
      </section>`;

    $('#pc-start', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#pc-start-input', el).value.trim();
      if (!/^\d{4}$/.test(v)) return;
      ef.pc = v;
      ef.network = '';
      go('electricity');
    });
    const drawBoard = () => {
      const boards = EN.boards.filter((b) => b.fuel === homeFuel);
      el.querySelectorAll('#home-fuel button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === homeFuel)));
      if (!boards.find((b) => b.id === homeBoard)) homeBoard = boards[0]?.id;
      $('#home-states', el).innerHTML = boards.map((b) => `<button role="tab" data-b="${esc(b.id)}" aria-selected="${b.id === homeBoard}">${esc(STATE_NAME[b.state] || b.state)}</button>`).join('');
      el.querySelectorAll('#home-states button').forEach((t) => t.addEventListener('click', () => ((homeBoard = t.dataset.b), drawBoard())));
      const b = boards.find((x) => x.id === homeBoard);
      const box = $('#home-board', el);
      if (!b) return (box.innerHTML = '<p class="board-note">No plans for this fuel yet.</p>');
      box.innerHTML = `<p class="board-note">${esc(b.network)} network, ${b.usage.toLocaleString('en-AU')} ${b.unit} a year, typical household, including GST</p>
        <ol class="best-rows">${b.ranking
          .slice(0, 5)
          .map((r, i) => `<li><button class="best-row ${i === 0 ? 'is-top' : ''}" data-plan="${esc(r.id)}"><span class="br-rank">${i + 1}</span><span class="br-who"><b>${esc(r.retailer)}</b><span>${esc(r.plan)}</span></span><span class="br-rate">${dollars(r.cost)}<span class="br-frac">/yr</span></span></button></li>`)
          .join('')}</ol>
        <div class="board-foot"><span class="muted">Typical market plan: <b>${dollars(b.median)}</b> a year</span><a href="#${b.fuel === 'E' ? 'electricity' : 'gas'}">Compare at your postcode</a></div>`;
      box.querySelectorAll('[data-plan]').forEach((x) => x.addEventListener('click', () => openPlan(x.dataset.plan, b.fuel)));
    };
    if (EN.boards.length) {
      el.querySelectorAll('#home-fuel button').forEach((b) => b.addEventListener('click', () => ((homeFuel = b.dataset.f), (homeBoard = null), drawBoard())));
      drawBoard();
    }
    el.querySelectorAll('.change-row[data-plan]').forEach((b) => b.addEventListener('click', () => openPlan(b.dataset.plan)));
  }

  // ---------- PLAN FINDER (electricity, gas, solar)
  const ef = { mode: 'electricity', pc: '', network: '', usage: DEFAULTS.E.usage, gusage: DEFAULTS.G.usage, tariff: 'any', demand: false, cl: 0, solar: 0, cond: false, business: false, standing: false, retailer: '', t: {} };
  function setMode(m) {
    ef.mode = m;
    if (m === 'solar' && !ef.solar) ef.solar = 2000;
    renderers.energy();
  }
  renderers.energy = () => {
    const el = $('#tab-energy');
    const fuel = ef.mode === 'gas' ? 'G' : 'E';
    const D0 = DEFAULTS[fuel];
    const title = { electricity: 'Electricity plans', gas: 'Gas plans', solar: 'Solar feed-in tariffs' }[ef.mode];
    const intro = {
      electricity: 'Every retailer’s published electricity plans for your address, ranked by estimated yearly cost.',
      gas: 'Every retailer’s published gas plans for your address, ranked by estimated yearly cost.',
      solar: 'Plans ranked by what they’d cost you after the solar feed-in credit, so a high feed-in rate can’t hide higher usage prices.',
    }[ef.mode];
    const ukey = fuel === 'G' ? 'gusage' : 'usage';
    el.innerHTML = `
      <h2 class="page-title">${title}</h2>
      <p class="muted">${intro}</p>
      <div class="filters" id="ef-f">
        <label class="field">Postcode<input type="text" inputmode="numeric" maxlength="4" data-k="pc" placeholder="e.g. 2000" /></label>
        <label class="field" id="ef-net">Network<select data-k="network"><option value="">All networks at this postcode</option></select></label>
        <label class="field">Usage per year (${D0.unit})<input type="number" data-k="${ukey}" min="0" step="100" list="ef-presets" /></label>
        <datalist id="ef-presets">${D0.presets.map(([l, v]) => `<option value="${v}">${esc(l)}</option>`).join('')}</datalist>
        ${fuel === 'E' ? `<label class="field">Tariff<select data-k="tariff"><option value="any">Any</option><option value="single">Single rate</option><option value="tou">Time of use</option></select></label>
        <label class="field">Solar export (kWh/yr)<input type="number" data-k="solar" min="0" step="100" /></label>
        <label class="field">Controlled load (kWh/yr)<input type="number" data-k="cl" min="0" step="100" /></label>` : ''}
        <label class="field">Retailer<select data-k="retailer"><option value="">All retailers</option>${EN.retailers.filter((r) => (fuel === 'E' ? r.elec : r.gas)).map((r) => `<option value="${esc(r.brand)}">${esc(r.name)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" data-k="cond" /> Include conditional discounts</label>
        <label class="check"><input type="checkbox" data-k="standing" /> Show standing offers</label>
        ${fuel === 'E' ? '<label class="check"><input type="checkbox" data-k="demand" /> Include demand tariffs</label>' : ''}
        <label class="check"><input type="checkbox" data-k="business" /> Business plans</label>
      </div>
      <p class="small muted presets">${D0.presets.map(([l, v]) => `<button class="textbtn small" data-preset="${v}">${esc(l)}: ${v.toLocaleString('en-AU')} ${D0.unit}</button>`).join(' ')}</p>
      <div id="ef-table"></div>
      <p class="small muted ef-note">Estimates include GST and are based on the usage you enter${fuel === 'E' ? ' with a typical household time-of-day pattern' : ''}. Conditional discounts are left out unless ticked. Your bill will differ; check the plan’s fact sheet before switching.</p>`;
    bindFilters($('#ef-f', el), ef, drawFinder);
    el.querySelectorAll('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        ef[ukey] = Number(b.dataset.preset);
        $(`[data-k="${ukey}"]`, el).value = ef[ukey];
        drawFinder();
      })
    );
    drawFinder();
  };

  let drawSeq = 0;
  async function drawFinder() {
    const seq = ++drawSeq; // ignore results from an older, slower search
    const fuel = ef.mode === 'gas' ? 'G' : 'E';
    const box = $('#ef-table');
    const pc = String(ef.pc || '').trim();
    if (!/^\d{4}$/.test(pc)) {
      $('#ef-net').style.display = 'none';
      box.innerHTML = '<div class="table-wrap"><div class="empty">Enter your 4-digit postcode to see the plans available at your address.</div></div>';
      return;
    }
    const state = postcodeState(pc);
    if (state === 'WA' || state === 'NT') {
      $('#ef-net').style.display = 'none';
      box.innerHTML = `<div class="table-wrap"><div class="empty notcovered">${notCovered(state, fuel)}</div></div>`;
      return;
    }
    if (!state || !EN.meta.states?.[state]) {
      box.innerHTML = `<div class="table-wrap"><div class="empty">No published plans found for postcode ${esc(pc)}${state ? ` (${esc(STATE_NAME[state])})` : ''}.</div></div>`;
      return;
    }
    box.innerHTML = '<div class="table-wrap"><div class="empty">Loading plans…</div></div>';
    const all = await plansFor(state);
    if (seq !== drawSeq) return;
    const here = all.filter((p) => fuelOf(p, fuel) && availableAt(p, pc));
    // Network choice
    const nets = [...new Set(here.flatMap((p) => p.d))].sort();
    const sel = $('#ef-net select');
    const netWrap = $('#ef-net');
    netWrap.style.display = nets.length ? '' : 'none';
    if (ef.network && !nets.includes(ef.network)) ef.network = '';
    if (nets.length === 1) ef.network = nets[0];
    sel.innerHTML = `${nets.length > 1 ? '<option value="">All networks at this postcode</option>' : ''}${nets.map((n) => `<option ${n === ef.network ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
    const opts = { usage: fuel === 'G' ? ef.gusage : ef.usage, cl: ef.cl, solar: ef.solar, conditional: ef.cond };
    const rows = [];
    for (const p of here) {
      const c = fuelOf(p, fuel);
      if (!p.detail || (ef.network && !p.d.includes(ef.network))) continue;
      if (ef.business ? p.cu !== 'BUSINESS' : p.cu === 'BUSINESS') continue;
      if (!ef.standing && p.t !== 'MARKET') continue;
      if (ef.retailer && p.b !== ef.retailer) continue;
      const isTou = c.tp.some((t) => t.kind === 'tou');
      const isDemand = c.tp.some((t) => t.kind === 'demand') || (fuel === 'E' && /\bdemand\b/i.test(p.n || ''));
      if (fuel === 'E' && ef.tariff === 'single' && isTou) continue;
      if (fuel === 'E' && ef.tariff === 'tou' && !isTou) continue;
      if (isDemand && !ef.demand) continue;
      const cost = annualCost(p, fuel, opts);
      if (!cost) continue;
      rows.push({ p, c, cost: cost.total, est: cost, h: headline(c) });
    }
    // Plans with data errors sort after every normal plan
    const sortCost = (r) => (r.p.bad ? 1e9 : 0) + r.cost;
    if (!rows.length) {
      box.innerHTML = `<div class="table-wrap"><div class="empty">No ${fuel === 'G' ? 'gas' : 'electricity'} plans match these filters at ${esc(pc)}.${fuel === 'G' ? ' Not every address has a gas connection.' : ''}</div></div>`;
      return;
    }
    const usageCell = (r) => (r.h?.single !== null && r.h?.single !== undefined ? `${cents(r.h.single)}<span class="small muted">/${fuel === 'G' ? 'MJ' : 'kWh'}</span>` : r.h?.tou ? r.h.tou.map((t) => `<div class="small">${esc((t.type || t.name || '').toLowerCase().replace(/_/g, ' '))} ${cents(t.c)}</div>`).join('') : '—');
    table(
      box,
      [
        { key: 'r', label: 'Retailer / plan', fmt: (r) => `<div class="bank">${esc(r.p.r)}</div><div class="prod">${esc(r.p.n)} ${tags(r.p, r.c)}</div>`, sort: (r) => r.p.r },
        { key: 'cost', label: 'Est. cost / yr', n: true, cls: 'rate', fmt: (r) => (r.p.bad ? '<span class="small muted">See details</span>' : dollars(r.cost)), defaultSort: true, sort: sortCost },
        { key: 'sup', label: 'Daily supply', n: true, fmt: (r) => cents(r.h?.supply), sort: (r) => r.h?.supply },
        { key: 'use', label: 'Usage', n: true, fmt: usageCell, sort: (r) => r.h?.single ?? r.h?.tou?.[0]?.c },
        ...(fuel === 'E' ? [{ key: 'fit', label: 'Solar feed-in', n: true, fmt: (r) => (r.h?.fit === null || r.h?.fit === undefined ? '—' : `${r.h.fit.toFixed(1)}c`), sort: (r) => -(r.h?.fit ?? -1) }] : []),
        { key: 'disc', label: 'Discounts', fmt: (r) => (r.c.disc || []).map((d) => `<span class="tag ${d.type === 'GUARANTEED' ? 'good' : ''}" title="${esc(d.desc || '')}">${esc(d.name)}${d.rate ? ` ${Math.round(d.rate * 1000) / 10}%` : ''}</span>`).join('') || '<span class="muted">None</span>', sort: (r) => -(r.c.disc || []).length },
        { key: 'term', label: 'Contract', fmt: (r) => `<span class="small">${r.c.fx ? 'Fixed prices' : 'Variable prices'}${r.c.term && r.c.term !== 'ONGOING' ? `, ${esc(r.c.term.replace('_', ' ').toLowerCase())}` : ''}</span>`, sort: (r) => (r.c.fx ? 0 : 1) },
      ],
      rows,
      Object.assign(ef.t, { highlightTop: true }),
      (r) => openPlan(r.p.id, fuel)
    );
  }

  // ---------- PLAN DRAWER
  const dayText = (days) => {
    const d = (days || []).filter((x) => x !== 'PUBLIC_HOLIDAYS');
    if (!d.length || d.length === 7) return 'Every day';
    if (['MON', 'TUE', 'WED', 'THU', 'FRI'].every((x) => d.includes(x)) && d.length === 5) return 'Weekdays';
    if (d.length === 2 && d.includes('SAT') && d.includes('SUN')) return 'Weekends';
    return DAYS_ALL.filter((x) => d.includes(x)).map((x) => x[0] + x.slice(1).toLowerCase()).join(', ');
  };
  const t = (s) => String(s || '').replace(/^T/, '').slice(0, 5);
  const per = (iso) => ({ P1D: 'a day', P1W: 'a week', P1M: 'a month', P3M: 'a quarter', P1Y: 'a year' })[iso] || (iso ? `per ${iso}` : '');
  const blocksText = (blocks, unit, perIso) =>
    (blocks || [])
      .map((b, i, a) => `${cents(b.p * (1 + GST) * 100)}/${unit}${b.v && i < a.length - 1 ? ` for the first ${b.v.toLocaleString('en-AU')} ${unit}${perIso ? ` ${per(perIso)}` : ''}` : i > 0 ? ' after that' : ''}`)
      .join('; ');

  async function openPlan(id, fuelHint) {
    const p = await findPlan(id);
    if (!p) return;
    const fuels = [p.e ? 'E' : null, p.g ? 'G' : null].filter(Boolean);
    const fuel = fuels.includes(fuelHint) ? fuelHint : fuels[0];
    const c = fuelOf(p, fuel);
    const unit = fuel === 'G' ? 'MJ' : 'kWh';
    const est = c ? annualCost(p, fuel, { usage: fuel === 'G' ? ef.gusage : ef.usage, cl: ef.cl, solar: ef.solar, conditional: ef.cond }) : null;
    const link = (u, label) => (u && /^https?:\/\//.test(u) ? `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener nofollow">${esc(label)} ↗</a>` : '');
    const tariffHtml = (c?.tp || [])
      .map((x) => {
        const head = `<div class="tp-head"><b>${esc(x.name || 'Tariff')}</b>${x.sd && x.ed && !(x.sd === '01-01' && x.ed === '12-31') ? ` <span class="muted small">${esc(x.sd)} to ${esc(x.ed)}</span>` : ''}${x.ty && x.ty !== 'OTHER' ? ` <span class="tag">${esc(x.ty.toLowerCase().replace(/_/g, ' '))}</span>` : ''}</div>`;
        const sup = x.sup !== null && x.sup !== undefined ? `<div>Daily supply: <b>${cents(x.sup * (1 + GST) * 100)}</b> a day</div>` : x.bands?.length ? `<div>Daily supply (banded): ${x.bands.map((b) => cents(b.p * (1 + GST) * 100)).join(', ')}</div>` : '';
        let rates = '';
        if (x.kind === 'single') rates = `<div>Usage: ${blocksText(x.blocks, unit, x.per)}</div>`;
        if (x.kind === 'tou') rates = `<table><thead><tr><th>Rate</th><th class="n">Price</th><th>When</th></tr></thead><tbody>${x.tou.map((r) => `<tr><td>${esc(r.name || r.type)}</td><td class="n">${blocksText(r.blocks, unit, r.per)}</td><td class="small">${r.win.map((w) => `${dayText(w.days)} ${t(w.s)}–${t(w.e)}`).join('<br>')}</td></tr>`).join('')}</tbody></table>`;
        if (x.kind === 'demand') rates = `<div>Demand charges: ${x.dem.map((d) => `${esc(d.name)} $${(d.amt * (1 + GST)).toFixed(4)}/${esc(d.unit)} ${t(d.s)}–${t(d.e)}`).join('; ')} <span class="muted small">(not included in the estimate)</span></div>`;
        return `<div class="tp">${head}${sup}${rates}</div>`;
      })
      .join('');
    openDrawer(`
      <h2 id="drawer-title">${esc(p.n)}</h2>
      <div class="muted">${esc(p.r)}, ${fuel === 'G' ? 'gas' : 'electricity'}${p.t !== 'MARKET' ? ', standing offer' : ''}</div>
      <div style="margin-top:8px">${tags(p, c)}</div>
      ${p.desc ? `<p>${esc(p.desc)}</p>` : ''}
      <div>${link(p.links.apply, 'Apply on the retailer’s site')} ${link(p.links.pricing, 'Fact sheet')}</div>
      ${p.bad ? '<p class="mm">This plan’s published data has errors (for example, prices that look like cents published as dollars), so no estimate is shown. Check the retailer’s fact sheet.</p>' : ''}
      ${est && !p.bad ? `<h4>Estimated cost</h4><dl class="kv"><dt>Supply charges</dt><dd>${dollars(est.supply)}</dd><dt>Usage</dt><dd>${dollars(est.energy)}</dd>${est.fees ? `<dt>Ongoing fees</dt><dd>${dollars(est.fees)}</dd>` : ''}${est.disc ? `<dt>Discounts</dt><dd>−${dollars(est.disc)}</dd>` : ''}${est.fit ? `<dt>Solar credit</dt><dd>−${dollars(est.fit)}</dd>` : ''}<dt><b>Total a year</b></dt><dd><b>${dollars(est.total)}</b> <span class="small muted">incl. GST, ${(fuel === 'G' ? ef.gusage : ef.usage).toLocaleString('en-AU')} ${unit}${ef.solar && fuel === 'E' ? `, ${ef.solar.toLocaleString('en-AU')} kWh exported` : ''}</span></dd></dl>${est.flags.length ? `<p class="small muted">Note: ${esc(est.flags.join('; '))}.</p>` : ''}` : ''}
      <h4>Prices (including GST)</h4>${tariffHtml || '<p class="muted">No tariff published.</p>'}
      ${c?.cl?.length ? `<h4>Controlled load</h4>${c.cl.map((x) => `<div>${esc(x.name || 'Controlled load')}: ${x.kind === 'single' ? blocksText(x.blocks, unit, x.per) : (x.tou || []).map((r) => `${esc(r.type)} ${blocksText(r.blocks, unit)}`).join('; ')}${x.sup ? `, supply ${cents(x.sup * (1 + GST) * 100)} a day` : ''}</div>`).join('')}` : ''}
      ${c?.fit?.length ? `<h4>Solar feed-in</h4>${c.fit.map((f) => `<div>${esc(f.name)}: ${f.kind === 'single' ? f.blocks.map((b) => `${(b.p * 100).toFixed(2)}c/kWh`).join(', ') : f.tv.map((x) => `${esc((x.type || '').toLowerCase())} ${x.blocks.map((b) => (b.p * 100).toFixed(2) + 'c').join(', ')}`).join('; ')} <span class="small muted">${esc((f.payer || '').toLowerCase())}${f.ed ? `, until ${esc(f.ed)}` : ''}</span></div>`).join('')}` : ''}
      ${c?.disc?.length ? `<h4>Discounts</h4>${c.disc.map((d) => `<div><b>${esc(d.name)}</b>${d.rate ? ` ${Math.round(d.rate * 1000) / 10}%` : ''}${d.amt ? ` $${d.amt}` : ''} <span class="small muted">${esc((d.type || '').toLowerCase())}${d.cat ? `, ${esc(d.cat.toLowerCase().replace(/_/g, ' '))}` : ''}</span>${d.desc ? `<div class="small muted">${esc(d.desc)}</div>` : ''}</div>`).join('')}` : ''}
      ${c?.fees?.length ? `<h4>Fees</h4><table><tbody>${c.fees.map((f) => `<tr><td>${esc((f.type || '').toLowerCase().replace(/_/g, ' '))}</td><td class="n">${f.amt !== null ? '$' + f.amt.toFixed(2) : f.rate !== null ? (f.rate * 100).toFixed(2) + '%' : '—'}</td><td class="small muted">${esc((f.term || '').toLowerCase().replace(/_/g, ' '))}</td></tr>`).join('')}</tbody></table>` : ''}
      ${c?.elig?.length ? `<h4>Eligibility</h4>${c.elig.map((e) => `<div>${esc(RESTRICTED[e.type] || e.type.toLowerCase().replace(/_/g, ' '))}${e.info ? `: <span class="muted">${esc(e.info)}</span>` : ''}</div>`).join('')}` : ''}
      <h4>Contract</h4>
      <dl class="kv">
        <dt>Prices</dt><dd>${c?.fx ? 'Fixed' : 'Variable'}${c?.var ? ` <span class="small muted">${esc(c.var)}</span>` : ''}</dd>
        ${c?.term ? `<dt>Term</dt><dd>${esc(c.term.replace('_', ' ').toLowerCase())}</dd>` : ''}
        ${c?.cool ? `<dt>Cooling off</dt><dd>${c.cool} days</dd>` : ''}
        ${c?.bill?.length ? `<dt>Billing</dt><dd>${c.bill.map(per).join(', ')}</dd>` : ''}
        ${c?.pay?.length ? `<dt>Payment</dt><dd>${esc(c.pay.map((x) => x.toLowerCase().replace(/_/g, ' ')).join(', '))}</dd>` : ''}
        <dt>Networks</dt><dd>${esc(p.d.join(', ') || '—')}</dd>
        <dt>Plan ID</dt><dd><code class="small">${esc(p.id)}</code></dd>
        <dt>Last updated</dt><dd>${esc(p.up ? new Date(p.up).toLocaleDateString('en-AU') : '—')}</dd>
      </dl>`);
  }

  // ---------- RETAILERS
  renderers.retailers = () => {
    const el = $('#tab-retailers');
    const q = new Map((EN.quality?.brands || []).map((b) => [b.brandId, b]));
    const rows = EN.retailers.map((r) => ({ ...r, q: q.get(r.brand) || {} }));
    el.innerHTML = `<h2 class="page-title">Energy retailers</h2><p class="muted">Every retailer publishing plans through the Consumer Data Right, with the quality of its data. Select a retailer for its full data-quality report.</p><div id="rt-table"></div>`;
    table(
      $('#rt-table', el),
      [
        { key: 'name', label: 'Retailer', fmt: (r) => `<div class="bank">${esc(r.name)}</div>` },
        { key: 'plans', label: 'Plans', n: true },
        { key: 'elec', label: 'Electricity', n: true },
        { key: 'gas', label: 'Gas', n: true },
        { key: 'states', label: 'States', fmt: (r) => esc(r.states.join(', ')), sort: (r) => r.states.length },
        { key: 'probs', label: 'Data findings by severity', n: true, fmt: (r) => ctx.levelChips(r.q), sort: (r) => { const L = r.q.levels || {}; return (L[1] || 0) * 1e8 + (L[2] || 0) * 1e6 + (L[3] || 0) * 1e4 + (L[4] || 0) * 100 + (L[5] || 0); } },
      ],
      rows,
      { sort: 'name', dir: 'asc' },
      (r) => ctx.openBrandReport(r.brand, 'energy')
    );
  };

  // ---------- ALL ENERGY INSIGHTS
  let boardSel = null;
  renderers.energyInsights = () => {
    const el = $('#tab-energy-insights');
    const groups = [...new Set(EN.insights.filter((i) => i.id !== 'dq').map((i) => i.group))];
    el.innerHTML = `
      <h2 class="page-title">All insights</h2>
      <p class="muted">What today's published plans show, for a typical home using ${DEFAULTS.E.usage.toLocaleString('en-AU')} kWh of electricity or ${DEFAULTS.G.usage.toLocaleString('en-AU')} MJ of gas a year.</p>
      ${groups.map((g) => `<h3 class="group-title">${esc(g)}</h3><div class="notes">${EN.insights.filter((i) => i.group === g).map((i) => `<article class="note"><h3>${esc(i.headline)}</h3><p>${esc(i.detail)}</p>${i.board ? `<button class="textbtn" data-board="${esc(i.board)}">Show this ranking</button>` : ''}</article>`).join('')}</div>`).join('')}
      <h2 class="page-title" id="rankings">Rankings</h2>
      <p class="muted">Each retailer's cheapest open market plan on the main network in each state. Plans limited to particular groups, and plans with data errors, are left out.</p>
      <div class="board-head"><label class="field">Ranking<select id="eb-select">${EN.boards.map((b) => `<option value="${esc(b.id)}">${b.fuel === 'E' ? 'Electricity' : 'Gas'}, ${esc(STATE_NAME[b.state] || b.state)} (${esc(b.network)}, ${b.n} retailers)</option>`).join('')}</select></label></div>
      <div id="eb-board"></div>
      <h2 class="page-title" id="changes">Price changes</h2>
      <div id="ec-list"></div>`;
    const sel = $('#eb-select', el);
    const draw = () => {
      const b = EN.boards.find((x) => x.id === sel.value);
      const box = $('#eb-board', el);
      if (!b) return (box.innerHTML = '<div class="card empty">No rankings yet.</div>');
      const vals = b.ranking.map((r) => r.cost);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const w = (v) => 12 + 88 * ((hi - v) / (hi - lo || 1));
      box.innerHTML = `<div class="card"><div class="bars">${b.ranking.map((r, i) => `<div class="bar-row" data-plan="${esc(r.id)}"><span class="rank">${i + 1}</span><span class="who">${esc(r.retailer)} <small>${esc(r.plan)}</small></span><span class="bar-track"><span class="bar-fill" style="width:${w(r.cost).toFixed(1)}%"></span></span><span class="val">${dollars(r.cost)}</span></div>`).join('')}</div><p class="median-note">Typical market plan: <b>${dollars(b.median)}</b> a year for ${b.usage.toLocaleString('en-AU')} ${b.unit}, including GST. Lower is better.</p></div>`;
      box.querySelectorAll('[data-plan]').forEach((x) => x.addEventListener('click', () => openPlan(x.dataset.plan, b.fuel)));
    };
    if (boardSel) sel.value = boardSel;
    sel.addEventListener('change', () => ((boardSel = sel.value), draw()));
    el.querySelectorAll('[data-board]').forEach((b) => b.addEventListener('click', () => ((sel.value = boardSel = b.dataset.board), draw(), $('#rankings').scrollIntoView({ behavior: 'smooth' }))));
    draw();
    const runs = EN.changes?.runs || [];
    const all = runs.flatMap((r) => r.changes.map((c) => ({ ...c, at: r.at })));
    const box = $('#ec-list', el);
    if (!all.length) box.innerHTML = '<div class="card empty">No price changes recorded yet. Changes appear after the second daily refresh.</div>';
    else
      table(
        box,
        [
          { key: 'at', label: 'Detected', fmt: (c) => esc(new Date(c.at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) },
          { key: 'retailer', label: 'Retailer / plan', fmt: (c) => `<div class="bank">${esc(c.retailer)}</div><div class="prod">${esc(c.plan)}</div>` },
          { key: 'fuel', label: 'Fuel', fmt: (c) => (c.fuel === 'E' ? 'Electricity' : 'Gas') + `<div class="small muted">${esc(c.states.join(', '))}</div>` },
          { key: 'from', label: 'Was', n: true, fmt: (c) => dollars(c.from) },
          { key: 'to', label: 'Now', n: true, fmt: (c) => dollars(c.to) },
          { key: 'delta', label: 'Change / yr', n: true, fmt: (c) => `<b style="color:var(${c.delta > 0 ? '--bad' : '--good'})">${c.delta > 0 ? '+' : '−'}${dollars(Math.abs(c.delta))}</b>`, sort: (c) => Math.abs(c.delta), defaultDir: 'desc' },
        ],
        all,
        { sort: 'at', dir: 'desc', limit: 300 },
        (c) => openPlan(c.id, c.fuel)
      );
  };

  return { renderHome, setMode, openPlan, ef };
}
