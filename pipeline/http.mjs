import { config } from './config.mjs';

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? ` — ${body.replace(/\s+/g, ' ').slice(0, 500)}` : ''}`);
    this.status = status;
    this.url = url;
  }
}

// Tiny semaphore
function semaphore(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active < n && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => {
        active--;
        next();
      });
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

const globalLimit = semaphore(config.globalConcurrency);
const hostLimits = new Map();
function hostLimit(url) {
  const host = new URL(url).host;
  if (!hostLimits.has(host)) hostLimits.set(host, semaphore(config.perHostConcurrency));
  return hostLimits.get(host);
}

// Turn Node's vague "fetch failed" into something diagnosable (DNS, TLS, refused, timeout…)
function describeNetworkError(err, url) {
  if (err?.name === 'AbortError') return Object.assign(new Error(`Timed out after ${config.timeoutMs / 1000}s for ${url}`), { status: null });
  const c = err?.cause;
  const detail = c ? [c.code, c.reason || c.message].filter(Boolean).join(': ') : '';
  return Object.assign(new Error(`${err?.message || 'Network error'}${detail ? ` (${detail})` : ''} for ${url}`), { status: null });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const stats = { requests: 0, failures: 0, retries: 0 };

/**
 * GET a CDR endpoint with x-v / x-min-v version negotiation, retries and backoff.
 * Returns { json, version } where version is the x-v the holder responded with.
 */
export function getJson(url, { xv, xmin }) {
  return hostLimit(url)(() => globalLimit(() => doGet(url, xv, xmin)));
}

// Which version headers worked for each host + endpoint, so we only probe once per holder.
const versionCache = new Map();

const isVersionError = (status, body) =>
  status === 406 || ((status === 400 || status === 422) && /version/i.test(body));

/**
 * Version strategy. Some holders don't honour x-min-v ranges and reject the whole
 * request (406 Header/UnsupportedVersion) instead of returning their highest supported
 * version. So: try the range first (standard behaviour), then each exact version from
 * newest to oldest, and remember what worked for that host.
 */
async function doGet(url, xv, xmin) {
  const cacheKey = `${new URL(url).host}|${xv}-${xmin}`;
  const modes = [{ xv, xmin }];
  for (let v = xv; v >= xmin; v--) modes.push({ xv: v, xmin: v });
  const cached = versionCache.get(cacheKey);
  if (cached) modes.unshift(cached);

  let lastErr;
  const tried = new Set();
  for (const mode of modes) {
    const sig = `${mode.xv}-${mode.xmin}`;
    if (tried.has(sig)) continue;
    tried.add(sig);
    try {
      const r = await attemptGet(url, mode);
      versionCache.set(cacheKey, mode);
      return r;
    } catch (err) {
      lastErr = err;
      if (!err.versionError) {
        stats.failures++;
        throw err; // only keep probing on version problems
      }
    }
  }
  stats.failures++;
  throw lastErr;
}

async function attemptGet(url, { xv: version, xmin }) {
  let lastErr;
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
    try {
      stats.requests++;
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          'x-v': String(version),
          'x-min-v': String(xmin),
          'user-agent': config.userAgent,
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok && res.status !== 429 && res.status < 500) {
        const body = await res.text().catch(() => '');
        const err = new HttpError(res.status, url, body);
        err.versionError = isVersionError(res.status, body);
        throw err;
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        lastErr = new HttpError(res.status, url, await res.text().catch(() => ''));
        stats.retries++;
        await sleep(ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const json = await res.json();
      return { json, version: res.headers.get('x-v') || String(version) };
    } catch (err) {
      lastErr = err instanceof HttpError ? err : describeNetworkError(err, url);
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (attempt < config.retries) {
        stats.retries++;
        await sleep(1000 * 2 ** attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Follow links.next across pages, collecting data[key]. */
export async function getAllPages(firstUrl, versions, key) {
  const items = [];
  let url = firstUrl;
  let version;
  const seen = new Set();
  for (let i = 0; url && i < config.maxPages; i++) {
    if (seen.has(url)) break;
    seen.add(url);
    const { json, version: v } = await getJson(url, versions);
    version ??= v;
    const page = json?.data?.[key] ?? [];
    items.push(...page);
    const next = json?.links?.next;
    url = next ? new URL(next, url).toString() : null;
  }
  return { items, version };
}
