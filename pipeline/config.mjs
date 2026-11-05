// Central configuration. Everything can be overridden with environment variables.

// Banking can be published, collected privately (not on the public site), or switched off.
//   CDR_BANKING=public  → written to site/data and shown on the website
//   CDR_BANKING=private → written to private-data/banking (push it to a private repo); removed from the site
//   CDR_BANKING=off     → not fetched at all; removed from the site
const bankingMode = ['public', 'private', 'off'].includes(process.env.CDR_BANKING) ? process.env.CDR_BANKING : 'private';
const siteData = new URL('../site/data/', import.meta.url).pathname;

export const config = {
  bankingMode,
  siteData,
  // CDR Register: lists every data holder brand and its public base URI.
  registerUrl:
    process.env.CDR_REGISTER_URL ||
    'https://api.cdr.gov.au/cdr-register/v1/banking/data-holders/brands/summary',
  registerVersion: { xv: 2, xmin: 1 },

  // Product reference endpoints (unauthenticated, public). We ask for the newest
  // version we understand and accept anything down to v1; the normaliser is tolerant.
  productsPath: '/cds-au/v1/banking/products',
  productsVersion: { xv: 6, xmin: 1 },
  productDetailVersion: { xv: 8, xmin: 1 },
  pageSize: 100,
  maxPages: 50,

  // Politeness / resilience
  globalConcurrency: Number(process.env.CDR_GLOBAL_CONCURRENCY || 16),
  perHostConcurrency: Number(process.env.CDR_PER_HOST_CONCURRENCY || 3),
  timeoutMs: Number(process.env.CDR_TIMEOUT_MS || 25000),
  retries: 3,
  userAgent: 'cdr-product-comparator/1.0 (+open-source product comparison)',

  // Optional: only fetch some brands (comma-separated substrings), handy for debugging.
  brandFilter: (process.env.CDR_BRAND_FILTER || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // Comparison scenarios used for insights
  scenarios: {
    homeLoanLvr: 80, // headline LVR
    lowLvr: 60,
    highLvr: 85,
    depositBalance: 10000,
    homeLoanFixedTerms: [12, 24, 36, 60],
    termDepositTerms: [3, 6, 12, 24, 36, 60],
  },

  // Website & PDF checks: follow the URLs each bank publishes in its CDR data, plus
  // rate/fee/terms pages and PDFs linked one click from those pages.
  web: {
    // Website checks run by default only when banking is public (no need to crawl banks' sites privately)
    enabled: process.env.CDR_WEB ? process.env.CDR_WEB !== '0' : bankingMode === 'public',
    // Render JavaScript-heavy pages in headless Chromium when plain HTML has almost no text
    render: process.env.CDR_WEB_RENDER === '1',
    maxUrlsPerBrand: Number(process.env.CDR_WEB_MAX_URLS || 150),
    maxLinkedDocsPerBrand: Number(process.env.CDR_WEB_MAX_LINKED || 60),
    maxLinkedPerPage: 15,
    perHostConcurrency: 2,
    globalConcurrency: Number(process.env.CDR_WEB_CONCURRENCY || 12),
    timeoutMs: 20000,
    maxHtmlBytes: 4e6,
    maxPdfBytes: 15e6,
    maxPdfPages: 80,
    // Stop starting new requests after this long, so the daily job always finishes
    timeBudgetMs: Number(process.env.CDR_WEB_BUDGET_MIN || 40) * 60e3,
    userAgent: 'cdr-product-comparator/1.0 (+public CDR product data quality check; respects robots.txt)',
  },

  // Energy generic plans, published by the AER (Energy Made Easy) for every retailer
  energy: {
    enabled: process.env.CDR_ENERGY !== '0',
    retailersFile: process.env.CDR_ENERGY_RETAILERS || new URL('./energy/retailers.json', import.meta.url).pathname,
    // For testing: replace the AER host, e.g. CDR_ENERGY_BASE=http://localhost:8787/eme
    baseOverride: process.env.CDR_ENERGY_BASE || null,
    listVersion: { xv: 2, xmin: 1 },
    detailVersion: { xv: 4, xmin: 1 },
    pageSize: 1000,
    // Plan detail is only re-fetched when a plan's lastUpdated changes; this caps the first run
    detailBudgetMs: Number(process.env.CDR_ENERGY_DETAIL_BUDGET_MIN || 40) * 60e3,
    // Parallel plan-detail requests (all go to the one AER host; keep this modest)
    detailConcurrency: Number(process.env.CDR_ENERGY_DETAIL_CONCURRENCY || 6),
    web: process.env.CDR_ENERGY_WEB !== '0',
    // Plans per retailer whose fact sheets are checked each day (rotates so all are covered over time)
    webPlansPerRetailer: Number(process.env.CDR_ENERGY_WEB_PLANS || 12),
    webBudgetMs: Number(process.env.CDR_ENERGY_WEB_BUDGET_MIN || 25) * 60e3,
    outDir: process.env.CDR_ENERGY_OUT_DIR || new URL('../site/data/energy/', import.meta.url).pathname,
  },

  outDir: process.env.CDR_OUT_DIR || (bankingMode === 'public' ? siteData : new URL('../private-data/banking/', import.meta.url).pathname),
  historyDays: 30,
};
