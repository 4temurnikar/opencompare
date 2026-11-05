# OpenCompare

Independent comparisons of Australian **energy plans** (and, when switched on, **banking products**) using the public **Consumer Data Right (CDR)** product data, with plain-English insights, a postcode plan finder and a data-quality report. Refreshes automatically every morning.

No accreditation, API keys or database needed: CDR product and plan reference data is public and unauthenticated under the Consumer Data Standards.

## Sectors

| Sector | Status | Source |
|---|---|---|
| **Energy** (electricity and gas) | Published | Generic plans for every retailer, served by the AER's Energy Made Easy service: `https://cdr.energymadeeasy.gov.au/<retailer>/cds-au/v1/energy/plans` |
| **Banking** | Off in this repository (`CDR_BANKING=off`); runs separately in `ob-comparator` for now | Every banking brand on the CDR Register |
| Non-bank lending | Not added yet (lending products, same considerations as banking) | Uses the banking APIs |
| Telecommunications | Not available | Standards exist but the sector rollout was paused; no data holders publish |

### Banking modes

`CDR_BANKING` (a repository variable, or environment variable when running locally):

- `off` (default in this repository): banking isn't fetched at all and the site shows no banking menus.
- `private`: banking data is fetched daily into `private-data/banking/` (git-ignored) and removed from the public site. If the repository variable `BANKING_DATA_REPO` and secret `BANKING_DATA_TOKEN` are set, the workflow pushes it to that **private** repository, which also keeps the history for change detection. Website crawling of banks' sites is skipped in this mode.
- `public`: banking is published on the site again (Banking menu, pages and data-quality report return automatically).

**Combining with the banking site later:** set the repository variable `CDR_BANKING` to `public` and run the workflow. Banking pages, menus and data quality appear alongside energy; nothing needs merging, because this repository already holds the banking code.

Note: banking data committed before switching to `private` remains in this repository's git history.

## Energy: how it works

```
AER retailer list (pipeline/energy/retailers.json, 83 brands on 76 feeds)
     │
     ▼
GET {feed}/cds-au/v1/energy/plans?effective=CURRENT     (list: geography, lastUpdated)
GET {feed}/cds-au/v1/energy/plans/{planId}              (detail, only when lastUpdated changed)
     │
     ▼
normalise ─► tariff periods, single / time-of-use / demand rates, stepped blocks, controlled load,
     │       solar feed-in, discounts, fees, eligibility, networks and postcodes (prices $ excl. GST)
     ▼
cost ──────► site/energy-cost.js: one cost model shared by the pipeline and the website
     │
     ▼
insights ──► cheapest plan per state network, standing-offer gap, best feed-in, price changes
     │
     ▼
quality ───► CDS energy schema + "required if" rules, price plausibility, links, and prices on a
     │       rotating sample of each retailer's plan fact sheets (12 plans per retailer per day)
     ▼
site/data/energy/*.json (plans split by state) ──► website
```

**Cost estimate** = daily supply × days + usage through published stepped and seasonal rates (time-of-use split with a typical household pattern) + controlled load + ongoing membership fees − guaranteed discounts (conditional discounts only if ticked), then + 10% GST, − solar feed-in credit. Demand charges aren't estimated; demand plans are hidden unless requested. Gas rates without a stated unit are treated as per MJ.

**Rankings** use 4,000 kWh of electricity or 20,000 MJ of gas a year, residential market plans, on the network with the most plans in each state. Plans limited to particular groups (seniors, club members and so on) and plans with blocking data errors (such as prices in cents) are excluded from rankings; in the finder they're shown with a tag and sorted last.

**Incremental refresh:** plan detail is only re-read when a plan's `lastUpdated` changes, so the first run reads everything (capped by `CDR_ENERGY_DETAIL_BUDGET_MIN`, default 45 minutes; the rest is picked up the next day) and later runs read only what changed.

**Updating the retailer list:** the AER republishes its list of retailer base URIs from time to time. Run `node scripts/update-energy-retailers.mjs <url-of-the-AER-pdf>` to rebuild `pipeline/energy/retailers.json` from the PDF.

## Banking: how it works

```
CDR Register ──► every banking brand's publicBaseUri
     │
     ▼
GET {base}/cds-au/v1/banking/products            (paged, x-v negotiated)
GET {base}/cds-au/v1/banking/products/{id}       (full detail per product)
     │
     ▼
normalise ──► rates split by purpose / repayment / fixed term / LVR / balance tier
     │        fees, features, eligibility, constraints
     ▼
standards ─► every product checked against the Consumer Data Standards schema and rules
     │
     ▼
web ───────► (public mode) every URL the bank publishes in CDR plus rate sheets, fee schedules,
     │        PDS and key-facts PDFs one click away
     ▼
compare ───► each CDR rate, comparison rate and fee looked for on those pages and PDFs
     │
     ▼
insights ──► segment leaderboards, head-to-heads, market stats, day-on-day changes
```

| Folder | What's in it |
|---|---|
| `pipeline/config.mjs` | Endpoints, API versions, concurrency, comparison scenarios (LVR, balance, terms) |
| `pipeline/http.mjs` | `x-v`/`x-min-v` negotiation (range first, then exact versions newest-first, remembered per host), retries with backoff, `Retry-After`, per-host and global rate limits, descriptive network errors |
| `pipeline/fetch.mjs` | CDR Register discovery, product list paging, product detail fetch; one failing bank never breaks the run |
| `pipeline/normalise.mjs` | Flattens `lendingRates`/`depositRates`/tiers/fees; parses ISO-8601 durations; flags non-conformant data |
| `pipeline/insights.mjs` | Leaderboards and narrative insights; rate-change diff |
| `pipeline/standards.mjs` | Consumer Data Standards checks: mandatory fields, allowed values, RateString / AmountString / date / URI / ISO-duration formats, conditional `additionalValue` and `additionalInfo` rules |
| `pipeline/cds/banking-products.json` | Product schemas extracted from the official CDS OpenAPI file (v1.36.0: list v5, detail v7) |
| `pipeline/web.mjs` | Website and PDF reader: robots.txt, 2 requests per host, size and time limits, optional headless Chromium for JavaScript pages, PDF text via pdf.js |
| `pipeline/consistency.mjs` | Compares CDR figures with page and PDF content; link health |
| `pipeline/dq.mjs` | Catalogue of every check: label, category, severity |
| `scripts/update-cds-schema.mjs` | Refreshes both schema files (`banking-products.json`, `energy-plans.json`) when a new standard is published |
| `pipeline/energy/build.mjs` | Energy run: plan lists, incremental detail, costs, insights, data quality, output files |
| `pipeline/energy/normalise.mjs` | Energy plan payload → compact record |
| `pipeline/energy/standards.mjs` | Energy schema checks, conditional rules, price plausibility |
| `pipeline/energy/insights.mjs` | Energy rankings and insights |
| `pipeline/energy/retailers.json` | AER list of retailer brands and feed URLs |
| `site/energy-cost.js` | Annual cost model shared by the pipeline and the website |
| `site/energy-ui.js` | Energy pages: home, plan finder, retailers, insights |
| `scripts/mock-energy.mjs` | Mock AER feeds with fictional retailers and fact sheets |
| `scripts/update-energy-retailers.mjs` | Rebuilds the retailer list from the AER's PDF |
| `pipeline/build.mjs` | Orchestrates the run and writes `site/data/` |
| `site/` | The website — plain HTML/CSS/JS, no build step |
| `scripts/mock-server.mjs` | Local mock of the Register + data-holder APIs (fictional banks) for offline testing |

## Website (banking pages, when published)

- **Insights** — auto-generated findings, leaderboards for ~30 segments, and recent rate changes
- **Home loans** — filter by owner-occupied/investment, P&I/interest-only, variable/fixed term, LVR, offset, loan amount; shows comparison rate, monthly repayment and ongoing fees
- **Savings & term deposits** — base vs bonus vs intro rates and bonus conditions; term deposits by term with interest at maturity
- **Cards & personal loans** — purchase/cash rates, annual fees, estimated yearly cost at your balance
- **All products** — search every product from every bank
- **Data quality** — for every bank: standards conformance, data accuracy, link health and whether CDR rates and fees match the bank's own pages and PDFs. Each bank opens a full report listing every finding with the product, field, value and source page.

Every row opens a detail panel with all published rates, fees, eligibility and constraints, plus a link to the bank's page.

## Deploy (GitHub Pages, ~5 minutes)

1. Create a GitHub repo and push this folder to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write.**
4. **Actions → Daily CDR refresh → Run workflow** for the first load.

After that it runs every day at ~4:20 am Melbourne time, commits the new data (giving you a history and change detection), and redeploys the site.

> The repo must be **public** for free GitHub Pages, or on a paid plan for private repos. Any static host works — Netlify, Cloudflare Pages, S3 + CloudFront, Azure Static Web Apps — just run `node pipeline/build.mjs` on a daily schedule and publish `site/`.

## Run locally

Requires Node 20+.

```bash
npm install            # once: installs pdf.js for reading PDFs
npm run refresh        # banking (per CDR_BANKING) then energy
npm run refresh:energy # energy only
npm run serve          # http://localhost:8080
```

Offline, against the mock APIs:

```bash
npm run mock:energy &        # fictional energy retailers on :8788
npm run refresh:energy:mock
npm run mock &               # fictional banks on :8787
CDR_BANKING=public npm run refresh:mock
MOCK_SHIFT=1 npm run mock   # restart with shifted rates, refresh again to see change detection
```

Useful environment variables: `CDR_BANKING` (`private` / `public` / `off`), `CDR_ENERGY=0` (skip energy), `CDR_ENERGY_WEB=0` (skip fact-sheet checks), `CDR_ENERGY_WEB_PLANS` (fact sheets per retailer per day), `CDR_ENERGY_DETAIL_BUDGET_MIN`, `CDR_BRAND_FILTER="agl,origin"` (only matching retailers or banks), `CDR_PER_HOST_CONCURRENCY`, `CDR_GLOBAL_CONCURRENCY`, `CDR_TIMEOUT_MS`, `CDR_SAVE_RAW=1` (keep raw payloads in `raw/` for debugging), `CDR_WEB=0` (skip website and PDF checks), `CDR_WEB_RENDER=1` (render JavaScript pages with headless Chromium; needs `npm i playwright && npx playwright install chromium`), `CDR_WEB_BUDGET_MIN` (time limit for the web stage), `CDR_WEB_MAX_URLS` / `CDR_WEB_MAX_LINKED` (per-bank page limits).


## Data-quality checks

| Category | What is checked |
|---|---|
| API availability | Product endpoints respond; product list not empty |
| Standards conformance | At the current detail version (v7): mandatory fields, allowed values, data types. At every version: RateString, AmountString, RFC 3339 dates, ISO 4217 currencies, URIs, ISO 8601 durations, `additionalValue` / `additionalInfo` rules from the standard's Product Components tables (e.g. FIXED needs a term, PERIODIC fee needs a period, MAX_LVR as a RateString). Older versions are noted, not penalised. |
| Data accuracy | Rates published as percentages instead of decimals, implausible values, home-loan rates without purpose / repayment type / comparison rate, products with no rates, stale `lastUpdated` |
| Links | Broken links, product links that land on the homepage, http instead of https; blocked and robots-excluded pages are reported as "not checked", not as faults |
| Matches the bank's website | Each CDR rate, comparison rate and fee looked for on the product's own pages and PDFs. Shared rate schedules are read only in the section about that product, so one product's figure can't confirm another's. |

**Severity:** *error* breaks the standard or can't be used; *warning* is probably wrong or missing; *note* is informational.

**Reading "not found" correctly:** it means the exact figure didn't appear on the pages and PDFs linked from that product. Rates loaded by JavaScript the reader couldn't run, images of tables, or different rounding can cause it. Treat it as a prompt to check, not proof of an error.

### Things to know about the website checks

- **Bot protection.** Some banks' sites block automated visitors, especially from overseas cloud servers like GitHub's. Those pages are reported as "blocked" and the product as "not checked". If many banks block the GitHub runner, run the job from an Australian machine or cloud region instead.
- **Politeness.** The reader identifies itself in its user agent, obeys robots.txt, sends at most 2 requests at a time to any site, and only follows links one click from URLs the bank itself published in CDR.
- **Run time.** The web stage stops starting new requests after `CDR_WEB_BUDGET_MIN` minutes (default 40) so the daily job always finishes; anything not reached is marked "not checked (time limit)".
- **Terms of use.** Reading public pages and PDFs a bank links to from its own CDR data is low-risk, but check that it fits each site's terms before publishing findings about named banks.
- **New standard versions.** Run `node scripts/update-cds-schema.mjs` to pull the latest schema from the ConsumerDataStandardsAustralia/standards repository.

## Comparison rules

- Home-loan leaderboards use each lender's best **non-tailored** rate at **80% LVR** (also 60% and 85% for LVR insights). Rates with `loanPurpose`/`repaymentType` of `UNCONSTRAINED` count for both.
- Savings "max rate" = highest base rate + highest bonus rate applicable at a $10,000 balance.
- Personal loans include tailored products (most are), labelled as "from" rates.
- Expired products (`effectiveTo` in the past) are dropped.
- Safety rails: the run aborts without overwriting yesterday's data if the Register returns nothing or fewer than 30% of brands respond.

Change any of these in `pipeline/config.mjs`.

## Known real-world quirks handled

- Holders that don't honour `x-min-v` ranges or only serve one exact version (e.g. ANZ on v5)
- Rejected `page-size` (retries with defaults) and repeated items across pages
- LVR tiers published as fractions (0.8) vs percentages (80)
- Rates published as percentages instead of decimals (corrected and flagged)
- Several brands sharing one base URI
- Throttling (honours `Retry-After`), slow or dead endpoints (timeouts, isolated failures)

## Known holder-side failures (Nov 2026)

These are the data holders' problems, not the pipeline's. The daily run retries them automatically and lists them on the Data quality tab.

| Brand | Error | Meaning |
|---|---|---|
| DDH Graham | 401 | Public product endpoint requires authentication (non-conformant) |
| IMB Bank | 502 | Bad gateway at the holder |
| Geelong Bank | 520 | Origin error behind Cloudflare |
| Aussie Home Loans | 404 | Registered base URI has no products endpoint |
| Thriday | fetch failed | Connection-level failure; cause logged from next run |
| Wise | 422 | Request rejected; full error needed to diagnose |

CBA - CommBiz and HSBC respond but publish no products (flagged as `NO_PRODUCTS`).

## Daily job notes

The commit step never merges data: it sets the fresh data aside, syncs to the latest `main`, puts the data back and pushes (retrying on races). Start manual runs with **Run workflow**, not **Re-run jobs**, because a re-run reuses the workflow file from the original commit.

## Disclaimer

General information only, not financial advice. Rates are as published by data holders and may differ from what a customer is offered.
