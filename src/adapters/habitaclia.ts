import { chromium, type Browser, type BrowserContext } from "playwright";
import { buildHabitacliaUrl, type SearchParams } from "../lib/url-builder.js";
import { getProxyConfigFor, isLikelyProxyFailure } from "../lib/proxy.js";

export type Listing = {
  external_id: string;
  portal: "habitaclia";
  title: string;
  price: number | null;
  url: string;
  surface_m2?: number | null;
  rooms?: number | null;
  bathrooms?: number | null;
  property_type?: string | null;
  operation?: string | null;
  address?: string | null;
  zone?: string | null;
  city?: string | null;
  images?: string[];
  description?: string | null;
  raw?: any;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function scrapeHabitacliaWithProxy(
  params: SearchParams,
  proxy: ReturnType<typeof getProxyConfigFor>,
): Promise<Listing[]> {
  const url = buildHabitacliaUrl(params);

  console.log(
    `[habitaclia] goto url=${url} params=${JSON.stringify(params)} proxy=${
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

    console.log(`[habitaclia] status=${status} finalUrl=${finalUrl} htmlBytes=${bytes}`);
    console.log(`[habitaclia] htmlPreview=${html.slice(0, 500).replace(/\n/g, " ")}`);

    const lower = html.toLowerCase();
    const blockHints: string[] = [];
    if (lower.includes("captcha")) blockHints.push("captcha");
    if (lower.includes("datadome")) blockHints.push("datadome");
    if (status === 403 || status === 429) blockHints.push(`http-${status}`);
    if (blockHints.length) {
      console.log(`[habitaclia] blockHints=${blockHints.join("|")}`);
    }

    const selector = "article.js-list-item[data-id], article.list-item-container[data-id]";
    const expectedHrefPart = params.operation === "alquiler" || params.operation === "alquiler_temporal" ? "alquiler-" : "comprar-";
    const rawNodes = await page.$$eval(selector, (nodes) => nodes.length);
    const listings = (await page.$$eval(selector, (nodes, expectedHrefPart) => {
      const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
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
      const absolute = (href: string) => {
        if (href.startsWith("http")) return href;
        if (href.startsWith("//")) return `https:${href}`;
        return `https://www.habitaclia.com/${href.replace(/^\//, "")}`;
      };
      const seen = new Set<string>();
      const results: Array<Record<string, unknown>> = [];

      for (const node of nodes) {
        const detailLinks = Array.from(node.querySelectorAll("a[href*='.htm']")) as HTMLAnchorElement[];
        const titleLink =
          detailLinks.find((link) => {
            const href = link.getAttribute("href") || "";
            return href.includes(expectedHrefPart) && !href.includes("/inmobiliaria-") && normalize(link.textContent).length > 0;
          }) || null;
        const href = node.getAttribute("data-href") || titleLink?.getAttribute("href") || "";
        if (!href.includes(expectedHrefPart)) continue;

        const id =
          node.getAttribute("data-id") ||
          node.id?.replace(/^id/, "") ||
          href.match(/-i(\d+)\.htm/)?.[1] ||
          "";
        if (!id || seen.has(id)) continue;

        const text = normalize(node.textContent);
        const title = normalize(titleLink?.textContent) || normalize((node.querySelector("img[alt]") as HTMLImageElement | null)?.alt) || "(sin título)";
        const images = Array.from(node.querySelectorAll("img"))
          .map((img) => img.getAttribute("src") || img.getAttribute("data-src") || "")
          .filter((src) => src && /habimg|habitaclia/i.test(src))
          .map((src) => (src.startsWith("//") ? `https:${src}` : src));

        seen.add(id);
        results.push({
          external_id: id,
          portal: "habitaclia",
          title,
          price: firstMoney(normalize((node.querySelector(".list-item-price") as HTMLElement | null)?.textContent) || text),
          url: absolute(href),
          surface_m2: firstNumber(text, /(\d+(?:[,.]\d+)?)\s*m(?:²|2)\b/i),
          rooms: firstNumber(text, /(\d+)\s*(?:habitaciones?|habs?)/i),
          bathrooms: firstNumber(text, /(\d+)\s*baños?/i),
          images,
          raw: { textPreview: text.slice(0, 500) },
        });
      }

      return results;
    }, expectedHrefPart)) as Listing[];

    console.log(`[habitaclia] selector="${selector}" matchedNodes=${rawNodes}`);
    console.log(`[habitaclia] extractedCards=${rawNodes} withId=${listings.length}`);
    if (listings.length === 0) {
      console.log(
        `[habitaclia] no listings extracted (selector may be stale or page is a captcha/empty shell)`
      );
    }
    console.log(`[habitaclia] finished collected=${listings.length}`);
    return listings;
  } catch (err) {
    console.error(`[habitaclia] FATAL`, err);
    throw err;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export async function scrapeHabitaclia(params: SearchParams): Promise<Listing[]> {
  const proxy = getProxyConfigFor("habitaclia");
  try {
    return await scrapeHabitacliaWithProxy(params, proxy);
  } catch (err) {
    if (proxy && isLikelyProxyFailure(err)) {
      console.warn("[habitaclia] proxy falló, reintentando sin proxy");
      return await scrapeHabitacliaWithProxy(params, null);
    }
    throw err;
  }
}
