import { config } from './config.mjs';
import { getJson, getAllPages } from './http.mjs';

/** Discover every banking data holder brand from the CDR Register. */
export async function fetchRegister() {
  // The register summary returns `data` as a flat array of brands (not paginated).
  const { json } = await getJson(config.registerUrl, config.registerVersion);
  const brands = Array.isArray(json.data) ? json.data : json.data?.dataHolderBrands ?? [];
  const out = [];
  const seen = new Set();
  for (const b of brands) {
    if (!b.publicBaseUri) continue;
    if (b.industries && !b.industries.map((s) => s.toLowerCase()).includes('banking')) continue;
    const id = b.dataHolderBrandId || b.interimId || b.brandName;
    const base = b.publicBaseUri.replace(/\/+$/, '');
    const key = `${base}|${b.brandName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      config.brandFilter.length &&
      !config.brandFilter.some((f) => b.brandName.toLowerCase().includes(f))
    )
      continue;
    out.push({
      brandId: id,
      brandName: b.brandName.trim(),
      publicBaseUri: base,
      logoUri: b.logoUri || null,
      abn: b.abn || null,
      registerLastUpdated: b.lastUpdated || null,
    });
  }
  return out.sort((a, b) => a.brandName.localeCompare(b.brandName));
}

/**
 * Fetch one brand's product list and every product's detail.
 * Never throws: errors are captured so one bad holder can't break the run.
 */
export async function fetchBrand(brand) {
  const started = Date.now();
  const result = {
    brand,
    products: [],
    errors: [],
    listVersion: null,
    detailVersions: {},
    ok: false,
  };
  const listUrl = `${brand.publicBaseUri}${config.productsPath}?page-size=${config.pageSize}`;
  let list;
  try {
    const r = await getAllPages(listUrl, config.productsVersion, 'products').catch(async (e) => {
      // Some holders reject page-size; retry with defaults.
      if (e.status === 400 || e.status === 422)
        return getAllPages(`${brand.publicBaseUri}${config.productsPath}`, config.productsVersion, 'products');
      throw e;
    });
    list = r.items;
    result.listVersion = r.version;
    // Some holders return an empty list when page-size is supplied; retry with defaults.
    if (!list.length) {
      const r2 = await getAllPages(`${brand.publicBaseUri}${config.productsPath}`, config.productsVersion, 'products').catch(() => null);
      if (r2?.items?.length) {
        list = r2.items;
        result.listVersion = r2.version;
      }
    }
    if (!list.length) result.errors.push({ stage: 'empty', message: 'Products endpoint responded but returned no products', status: null });
  } catch (e) {
    result.errors.push({ stage: 'list', message: e.message, status: e.status ?? null });
    result.durationMs = Date.now() - started;
    return result;
  }

  // De-dupe (some holders repeat items across pages)
  const unique = [...new Map(list.map((p) => [p.productId, p])).values()];

  await Promise.all(
    unique.map(async (p) => {
      const url = `${brand.publicBaseUri}${config.productsPath}/${encodeURIComponent(p.productId)}`;
      try {
        const { json, version } = await getJson(url, config.productDetailVersion);
        result.detailVersions[version] = (result.detailVersions[version] || 0) + 1;
        result.products.push({ ...p, ...(json.data || {}), _xv: version });
      } catch (e) {
        result.errors.push({ stage: 'detail', productId: p.productId, message: e.message, status: e.status ?? null });
        result.products.push({ ...p, _detailMissing: true });
      }
    })
  );
  result.ok = true;
  result.durationMs = Date.now() - started;
  return result;
}
