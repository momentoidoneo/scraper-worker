import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildFotocasaUrl, type SearchParams } from "../lib/url-builder.js";
import { getProxyConfigFor, isLikelyProxyFailure } from "../lib/proxy.js";

export type Listing = {
  external_id: string;
  portal: "fotocasa";
  title: string;
  price: number | null;
  url: string;
  surface_m2?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  property_type?: string | null;
  listing_type?: "particular" | "agencia" | null;
  operation?: string | null;
  address?: string | null;
  zone?: string | null;
  city?: string | null;
  images?: string[];
  description?: string | null;
  published_at?: string | null;
  raw?: any;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

const MAX_SCROLLS = envInt("FOTOCASA_MAX_SCROLLS", 14, 0, 40);
const MAX_RESULTS = envInt("FOTOCASA_MAX_RESULTS", 80, 10, 200);

function envFlag(name: string, fallback: boolean): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function priceBandsFor(operation: string): Array<{ price_min?: number; price_max?: number }> {
  const rental = operation === "alquiler" || operation === "alquiler_temporal" || operation === "rent";
  if (rental) {
    return [
      { price_max: 800 },
      { price_min: 800, price_max: 1200 },
      { price_min: 1200, price_max: 1800 },
      { price_min: 1800, price_max: 3000 },
      { price_min: 3000 },
    ];
  }

  return [
    { price_max: 150000 },
    { price_min: 150000, price_max: 250000 },
    { price_min: 250000, price_max: 400000 },
    { price_min: 400000, price_max: 700000 },
    { price_min: 700000, price_max: 1200000 },
    { price_min: 1200000 },
  ];
}

function intersectPriceBand(
  band: { price_min?: number; price_max?: number },
  params: SearchParams,
): { price_min?: number; price_max?: number } | null {
  const min = Math.max(band.price_min ?? Number.NEGATIVE_INFINITY, params.price_min ?? Number.NEGATIVE_INFINITY);
  const max = Math.min(band.price_max ?? Number.POSITIVE_INFINITY, params.price_max ?? Number.POSITIVE_INFINITY);
  if (Number.isFinite(min) && Number.isFinite(max) && min >= max) return null;
  return {
    price_min: Number.isFinite(min) ? min : undefined,
    price_max: Number.isFinite(max) ? max : undefined,
  };
}

function segmentLabel(segment: { price_min?: number; price_max?: number }): string {
  if (segment.price_min != null && segment.price_max != null) return `${segment.price_min}-${segment.price_max}`;
  if (segment.price_min != null) return `from-${segment.price_min}`;
  if (segment.price_max != null) return `to-${segment.price_max}`;
  return "all";
}

function searchSegments(params: SearchParams): Array<{ params: SearchParams; label: string; maxResults: number }> {
  const desired = Math.max(10, MAX_RESULTS);
  const wantsPrivate = normalizeText(params.listing_type) === "particular";
  const enabled = envFlag("FOTOCASA_SEGMENTED_SEARCH", true);
  if (!enabled || (!wantsPrivate && desired < 100)) {
    return [{ params, label: "all", maxResults: desired }];
  }

  const segments = priceBandsFor(params.operation)
    .map((band) => intersectPriceBand(band, params))
    .filter((band): band is { price_min?: number; price_max?: number } => Boolean(band));

  if (segments.length <= 1) {
    return [{ params, label: "all", maxResults: desired }];
  }

  const perSegment = Math.max(18, Math.ceil(desired / segments.length));
  return segments.map((segment) => ({
    params: { ...params, ...segment },
    label: segmentLabel(segment),
    maxResults: perSegment,
  }));
}

function listingQualityScore(listing: Listing): number {
  const title = (listing.title || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const raw = listing.raw && typeof listing.raw === "object" && !Array.isArray(listing.raw)
    ? listing.raw as Record<string, unknown>
    : {};
  let score = 0;
  if (/\b(?:piso|casa|atico|apartamento|chalet|duplex|local|loft|estudio|vivienda)\b/.test(title)) score += 10;
  if (listing.price != null) score += 2;
  if (listing.surface_m2 != null) score += 1;
  if (listing.rooms != null) score += 1;
  if (String(raw.textPreview ?? "").length > 400) score += 1;
  if (raw.advertiserHint) score += 1;
  return score;
}

async function collectVisibleListings(page: Page): Promise<Listing[]> {
  const selector = "article";
  return (await page.$$eval(selector, (nodes) => {
    const detailPattern = /\/es\/(?:comprar|alquiler)\/vivienda\/[^?#]+\/(\d+)\/d(?:[?#].*)?$/;
    const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const absolute = (href: string) => {
      if (href.startsWith("http")) return href;
      if (href.startsWith("//")) return `https:${href}`;
      return `https://www.fotocasa.es${href.startsWith("/") ? href : `/${href}`}`;
    };
    const firstMoney = (text: string) => {
      const match = text.match(/(\d{1,3}(?:\.\d{3})+|\d+)\s*€/);
      return match ? Number(match[1].replace(/\./g, "")) : null;
    };
    const firstNumber = (text: string, pattern: RegExp) => {
      const match = text.match(pattern);
      if (!match) return null;
      const parsed = Number(match[1].replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const normalizeText = (value: string | null | undefined) => normalize(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const detectPropertyType = (value: string) => {
      const text = normalizeText(value);
      const patterns: Array<[string, RegExp]> = [
        ["duplex", /\bduplex(?:es)?\b/],
        ["atico", /\b(?:atico|aticos|penthouse|penthouses)\b/],
        ["estudio", /\b(?:estudio|estudios|studio|studios|loft|lofts)\b/],
        ["piso", /\b(?:piso|pisos|flat|flats|apartment|apartments|apartamento|apartamentos|vivienda|viviendas)\b/],
        ["local", /\b(?:local|locales|premises|commercial)\b/],
        ["oficina", /\b(?:oficina|oficinas|office|offices)\b/],
        ["garaje", /\b(?:garaje|garajes|garage|garages|parking)\b/],
        ["casa", /\b(?:casa|casas|house|houses|chalet|chalets|villa|villas)\b/],
      ];
      return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
    };
    const detectListingType = (value: string) => {
      const text = normalizeText(value);
      if (/\b(particular|propietario|private|privado)\b/.test(text)) return "particular";
      if (/\b(inmobiliaria|agencia|agency|professional|profesional|promotor|promotora|real estate|properties|lider de zona|calidad fotocasa)\b/.test(text)) return "agencia";
      return null;
    };
    const publishedAt = (value: string) => {
      const text = normalizeText(value);
      const now = Date.now();
      if (/\b(hoy|nuevo)\b/.test(text)) return new Date(now).toISOString();
      if (/\bayer\b/.test(text)) return new Date(now - 24 * 60 * 60 * 1000).toISOString();
      let match = text.match(/hace\s*(\d+)\s*(?:hora|horas|h)\b/);
      if (match) return new Date(now - Number(match[1]) * 60 * 60 * 1000).toISOString();
      match = text.match(/hace\s*(\d+)\s*(?:dia|dias|d)\b/);
      if (match) return new Date(now - Number(match[1]) * 24 * 60 * 60 * 1000).toISOString();
      return null;
    };
    const seen = new Set<string>();
    const results: Array<Record<string, unknown>> = [];

    for (const node of nodes) {
      const anchors = Array.from(node.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      const detailLinks = anchors.filter((link) => detailPattern.test(link.getAttribute("href") || ""));
      const cleanLinks = detailLinks.filter((link) => !(link.getAttribute("href") || "").includes("multimedia="));
      const looksLikeAgency = (value: string) => /líder de zona|inmobiliaria|real estate|agency|properties|partner inmobiliario|calidad fotocasa/i.test(value);
      const titleLink =
        cleanLinks.find((link) => {
          const text = normalize(link.textContent);
          return !looksLikeAgency(text) && /piso|casa|ático|atico|vivienda|apartamento|chalet|dúplex|duplex|local|loft|estudio/i.test(text);
        }) ||
        cleanLinks.find((link) => {
          const text = normalize(link.textContent);
          return !looksLikeAgency(text) && text.length > 20;
        }) ||
        cleanLinks[0] ||
        detailLinks[0];
      if (!titleLink) continue;

      const href = titleLink.getAttribute("href") || "";
      const id = href.match(detailPattern)?.[1] || node.getAttribute("data-id") || node.getAttribute("id") || "";
      if (!id || seen.has(id)) continue;

      const text = normalize(node.textContent);
      const advertiserHint = anchors.some((link) => (link.getAttribute("href") || "").includes("/inmobiliaria-")) ? " inmobiliaria" : "";
      const title = normalize(titleLink.textContent) || normalize((node.querySelector("img[alt]") as HTMLImageElement | null)?.alt) || "(sin título)";
      const images = Array.from(node.querySelectorAll("img"))
        .map((img) => img.getAttribute("src") || img.getAttribute("data-src") || "")
        .filter((src) => src && /fotocasa|static/i.test(src))
        .map((src) => (src.startsWith("//") ? `https:${src}` : src));

      seen.add(id);
      results.push({
        external_id: id,
        portal: "fotocasa",
        title,
        price: firstMoney(text),
        url: absolute(href),
        surface_m2: firstNumber(text, /(\d+(?:[,.]\d+)?)\s*m(?:²|2)\b/i),
        rooms: firstNumber(text, /(\d+)\s*(?:habs?|habitaciones?)/i),
        bathrooms: firstNumber(text, /(\d+)\s*baños?/i),
        images,
        property_type: detectPropertyType(title + " " + href + " " + text),
        listing_type: advertiserHint ? "agencia" : detectListingType(title + " " + href + " " + text),
        published_at: publishedAt(text),
        raw: { textPreview: text.slice(0, 1200), advertiserHint: advertiserHint.trim() || null },
      });
    }

    return results;
  })) as Listing[];
}

async function scrapeFotocasaWithProxy(
  params: SearchParams,
  proxy: ReturnType<typeof getProxyConfigFor>,
): Promise<Listing[]> {
  const segments = searchSegments(params);

  console.log(
    `[fotocasa] searches=${segments.length} maxTotal=${MAX_RESULTS} params=${JSON.stringify(params)} proxy=${
      proxy ? proxy.server : "none"
    }`
  );

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: proxy
        ? {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
          }
        : undefined,
    });
    context = await browser.newContext({
      userAgent: UA,
      locale: "es-ES",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    const globalMap = new Map<string, Listing>();
    let totalRawNodes = 0;
    for (const segment of segments) {
      const url = buildFotocasaUrl(segment.params);
      console.log(`[fotocasa] goto segment=${segment.label} url=${url}`);

      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500);
      const status = resp?.status() ?? 0;
      const finalUrl = page.url();
      const html = await page.content();
      const bytes = Buffer.byteLength(html, "utf8");

      console.log(`[fotocasa] status=${status} segment=${segment.label} finalUrl=${finalUrl} htmlBytes=${bytes}`);
      if (segment === segments[0]) {
        console.log(`[fotocasa] htmlPreview=${html.slice(0, 500).replace(/\n/g, " ")}`);
      }

      const lower = html.toLowerCase();
      const blockHints: string[] = [];
      if (lower.includes("captcha")) blockHints.push("captcha");
      if (lower.includes("datadome")) blockHints.push("datadome");
      if (status === 403 || status === 429) blockHints.push(`http-${status}`);
      if (blockHints.length) {
        console.log(`[fotocasa] blockHints=${blockHints.join("|")}`);
      }

      const selector = "article";
      const rawNodes = await page.$$eval(selector, (nodes) => nodes.length);
      totalRawNodes += rawNodes;
      const segmentMap = new Map<string, Listing>();
      let staleScrolls = 0;
      for (let scroll = 0; scroll <= MAX_SCROLLS && segmentMap.size < segment.maxResults; scroll += 1) {
        const before = segmentMap.size;
        for (const listing of await collectVisibleListings(page)) {
          const raw = listing.raw && typeof listing.raw === "object" && !Array.isArray(listing.raw)
            ? listing.raw as Record<string, unknown>
            : {};
          const enrichedListing = {
            ...listing,
            raw: { ...raw, searchSegment: segment.label },
          };
          const existing = segmentMap.get(listing.external_id);
          if (!existing || listingQualityScore(enrichedListing) > listingQualityScore(existing)) {
            segmentMap.set(listing.external_id, enrichedListing);
          }
        }

        staleScrolls = segmentMap.size === before ? staleScrolls + 1 : 0;
        if (staleScrolls >= 4) break;
        await page.evaluate(() => {
          window.scrollBy(0, Math.max(900, Math.floor(window.innerHeight * 0.95)));
        });
        await page.waitForTimeout(1200);
      }

      for (const listing of segmentMap.values()) {
        const existing = globalMap.get(listing.external_id);
        if (!existing || listingQualityScore(listing) > listingQualityScore(existing)) {
          globalMap.set(listing.external_id, listing);
        }
      }
      console.log(`[fotocasa] segment=${segment.label} extractedCards=${rawNodes} withId=${segmentMap.size}`);
    }
    const listings = Array.from(globalMap.values()).slice(0, MAX_RESULTS);

    console.log(`[fotocasa] selector="article" matchedNodes=${totalRawNodes}`);
    console.log(`[fotocasa] extractedCards=${totalRawNodes} withId=${listings.length} scrolls=${MAX_SCROLLS} searches=${segments.length}`);
    if (listings.length === 0) {
      console.log(
        `[fotocasa] no listings extracted (selector may be stale or page is a captcha/empty shell)`
      );
    }
    console.log(`[fotocasa] finished collected=${listings.length}`);
    return listings;
  } catch (err) {
    console.error(`[fotocasa] FATAL`, err);
    throw err;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export async function scrapeFotocasa(params: SearchParams): Promise<Listing[]> {
  const proxy = getProxyConfigFor("fotocasa");
  try {
    return await scrapeFotocasaWithProxy(params, proxy);
  } catch (err) {
    if (proxy && isLikelyProxyFailure(err)) {
      console.warn("[fotocasa] proxy falló, reintentando sin proxy");
      return await scrapeFotocasaWithProxy(params, null);
    }
    throw err;
  }
}
