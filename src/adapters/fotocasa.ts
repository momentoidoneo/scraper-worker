import { chromium, type Browser, type BrowserContext } from "playwright";
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

async function scrapeFotocasaWithProxy(
  params: SearchParams,
  proxy: ReturnType<typeof getProxyConfigFor>,
): Promise<Listing[]> {
  const url = buildFotocasaUrl(params);

  console.log(
    `[fotocasa] goto url=${url} params=${JSON.stringify(params)} proxy=${
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

    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const status = resp?.status() ?? 0;
    const finalUrl = page.url();
    const html = await page.content();
    const bytes = Buffer.byteLength(html, "utf8");

    console.log(`[fotocasa] status=${status} finalUrl=${finalUrl} htmlBytes=${bytes}`);
    console.log(`[fotocasa] htmlPreview=${html.slice(0, 500).replace(/\n/g, " ")}`);

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
    const listings = (await page.$$eval(selector, (nodes) => {
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
          listing_type: detectListingType(title + " " + href + " " + text),
          published_at: publishedAt(text),
          raw: { textPreview: text.slice(0, 500) },
        });
      }

      return results;
    })) as Listing[];

    console.log(`[fotocasa] selector="${selector}" matchedNodes=${rawNodes}`);
    console.log(`[fotocasa] extractedCards=${rawNodes} withId=${listings.length}`);
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
