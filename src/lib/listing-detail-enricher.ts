import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getProxyConfigFor, isLikelyProxyFailure, type ProxyConfig } from "./proxy.js";

type EnrichableListing = {
  portal?: string | null;
  url?: string | null;
  title?: string | null;
  description?: string | null;
  listing_type?: string | null;
  raw?: unknown;
  [key: string]: unknown;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeText(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = normalizeText(process.env[name]);
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function hasAgencySignal(listing: EnrichableListing): boolean {
  const raw = asRecord(listing.raw);
  const contactInfo = asRecord(raw?.contactInfo);
  const detail = asRecord(raw?._detailEnrichment);
  const text = normalizeText([
    listing.listing_type,
    raw?.listingType,
    raw?.advertiserType,
    raw?.publisherType,
    raw?.userType,
    raw?.sellerType,
    raw?.isProfessional,
    raw?.advertiserHint,
    contactInfo?.userType,
    contactInfo?.commercialName,
    contactInfo?.name,
    detail?.textPreview,
    detail?.agencyHints,
  ].filter((value) => value != null && value !== "").join(" "));

  return /\b(agencia|agencias|agency|inmobiliaria|professional|profesional|promotor|promotora|real estate|properties|consulting|calidad fotocasa|lider de zona)\b/.test(text);
}

function hasPrivateSignal(text: string): boolean {
  const value = normalizeText(text);
  return [
    /\b(?:sin|no)\s+(?:agencias|intermediarios|inmobiliarias)\b/,
    /\babstenerse\s+(?:agencias|intermediarios|inmobiliarias)\b/,
    /\btrato\s+directo\b/,
    /\bdirecto\s+(?:con\s+)?(?:propietario|propietaria|dueno|duena)\b/,
    /\b(?:soy|somos)\s+(?:el\s+|la\s+)?(?:propietario|propietaria|dueno|duena)\b/,
    /\b(?:particular|propietario|propietaria|dueno|duena)\s+(?:vende|alquila|ofrece)\b/,
    /\b(?:vende|alquila|ofrece)\s+(?:particular|propietario|propietaria|dueno|duena)\b/,
    /\bde\s+particular\s+a\s+particular\b/,
    /\banunciante\s+particular\b/,
  ].some((pattern) => pattern.test(value));
}

function shouldFetchDetail(listing: EnrichableListing, portal: string): boolean {
  if (!listing.url || !/^https?:\/\//i.test(listing.url)) return false;
  if (hasAgencySignal(listing)) return false;
  if (portal === "idealista" && !envFlag("IDEALISTA_DETAIL_ENRICHMENT_ENABLED", false)) return false;
  return true;
}

async function extractDetail(page: Page): Promise<{
  title: string;
  metaDescription: string;
  textPreview: string;
  agencyHints: string[];
  privateHints: string[];
}> {
  return await page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const text = normalize(document.body?.innerText || "");
    const title = normalize(document.title);
    const metaDescription = normalize(document.querySelector("meta[name='description']")?.getAttribute("content"));
    const linkText = Array.from(document.querySelectorAll("a[href]"))
      .map((link) => `${normalize(link.textContent)} ${(link as HTMLAnchorElement).href}`)
      .join(" ");
    const combined = `${title} ${metaDescription} ${text} ${linkText}`;
    const findHints = (patterns: RegExp[]) => patterns
      .filter((pattern) => pattern.test(combined))
      .map((pattern) => pattern.source)
      .slice(0, 8);

    return {
      title,
      metaDescription,
      textPreview: text.slice(0, 3600),
      agencyHints: findHints([
        /inmobiliaria/i,
        /agencia/i,
        /profesional/i,
        /promotor/i,
        /real estate/i,
        /\/inmobiliaria-/i,
        /calidad fotocasa/i,
        /lider de zona/i,
      ]),
      privateHints: findHints([
        /sin agencias/i,
        /no agencias/i,
        /abstenerse agencias/i,
        /trato directo/i,
        /directo con propietario/i,
        /particular vende/i,
        /vende particular/i,
        /de particular a particular/i,
      ]),
    };
  });
}

async function enrichWithProxy<T extends EnrichableListing>(
  listings: T[],
  portal: string,
  proxy: ProxyConfig | null,
): Promise<T[]> {
  const maxDetails = envInt("PRIVATE_DETAIL_ENRICHMENT_MAX_RESULTS", 35, 0, 120);
  const timeoutMs = envInt("PRIVATE_DETAIL_ENRICHMENT_TIMEOUT_MS", 18000, 5000, 60000);
  const delayMs = envInt("PRIVATE_DETAIL_ENRICHMENT_DELAY_MS", 650, 0, 5000);
  if (maxDetails === 0) return listings;

  const indexes = listings
    .map((listing, index) => ({ listing, index }))
    .filter(({ listing }) => shouldFetchDetail(listing, portal))
    .slice(0, maxDetails);
  if (!indexes.length) return listings;

  console.log(`[detail] portal=${portal} candidates=${indexes.length} proxy=${proxy ? proxy.server : "none"}`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: proxy ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
    });
    context = await browser.newContext({
      userAgent: UA,
      locale: "es-ES",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    for (const { listing, index } of indexes) {
      const started = Date.now();
      try {
        const response = await page.goto(String(listing.url), { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(delayMs);
        const detail = await extractDetail(page);
        const status = response?.status() ?? 0;
        const raw = asRecord(listing.raw) ?? { value: listing.raw };
        const text = `${detail.title} ${detail.metaDescription} ${detail.textPreview}`;
        listings[index] = {
          ...listing,
          description: listing.description || detail.metaDescription || undefined,
          listing_type: detail.agencyHints.length
            ? "agencia"
            : hasPrivateSignal(text)
              ? "particular"
              : listing.listing_type,
          raw: {
            ...raw,
            _detailEnrichment: {
              fetched: true,
              status,
              finalUrl: page.url(),
              title: detail.title,
              metaDescription: detail.metaDescription,
              textPreview: detail.textPreview,
              agencyHints: detail.agencyHints,
              privateHints: detail.privateHints,
              elapsedMs: Date.now() - started,
            },
          },
        };
      } catch (err) {
        const raw = asRecord(listing.raw) ?? { value: listing.raw };
        listings[index] = {
          ...listing,
          raw: {
            ...raw,
            _detailEnrichment: {
              fetched: false,
              error: err instanceof Error ? err.message.slice(0, 240) : String(err).slice(0, 240),
              elapsedMs: Date.now() - started,
            },
          },
        };
      }
    }

    return listings;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export async function enrichListingDetailsForPrivateSearch<T extends EnrichableListing>(
  listings: T[],
  portal: string,
): Promise<T[]> {
  if (!envFlag("PRIVATE_DETAIL_ENRICHMENT_ENABLED", true)) return listings;
  try {
    return await enrichWithProxy([...listings], portal, getProxyConfigFor(portal));
  } catch (err) {
    if (getProxyConfigFor(portal) && isLikelyProxyFailure(err)) {
      console.warn(`[detail] portal=${portal} proxy falló, reintentando sin proxy`);
      return await enrichWithProxy([...listings], portal, null);
    }
    console.warn(`[detail] portal=${portal} failed: ${err instanceof Error ? err.message : String(err)}`);
    return listings;
  }
}
