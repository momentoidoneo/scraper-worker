import { chromium, type Browser, type BrowserContext } from "playwright";
import { buildFotocasaUrl, type SearchParams } from "../lib/url-builder.js";
import { getProxyConfigFor } from "../lib/proxy.js";

export type Listing = {
  id: string;
  portal: "fotocasa";
  title: string;
  price: number | null;
  url: string;
  raw?: any;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function scrapeFotocasa(params: SearchParams): Promise<Listing[]> {
  const url = buildFotocasaUrl(params);
  const proxy = getProxyConfigFor("fotocasa");

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

    const selector =
      "[data-test='listing-item'], article.re-Searchresult-item, [data-cy='listing-item'], div.re-CardPackMinimal";
    const nodes = await page.$$(selector);
    console.log(`[fotocasa] selector="${selector}" matchedNodes=${nodes.length}`);

    const listings: Listing[] = [];
    for (const node of nodes) {
      try {
        const id =
          (await node.getAttribute("data-test-id")) ||
          (await node.getAttribute("data-id")) ||
          (await node.getAttribute("id")) ||
          "";

        const linkEl = await node.$("a[href*='/comprar/'], a[href*='/alquiler/'], a.re-CardPackMinimal-info");
        const href = (await linkEl?.getAttribute("href")) || "";
        const title =
          ((await (await node.$("h2, h3, [class*='title']"))?.innerText()) || "").trim();

        const priceEl = await node.$("[class*='price'], [data-test='price']");
        const priceText = (await priceEl?.innerText())?.replace(/[^\d]/g, "") || "";
        const price = priceText ? Number(priceText) : null;

        if (href || title) {
          const finalId = id || href.split("/").filter(Boolean).pop() || crypto.randomUUID();
          listings.push({
            id: finalId,
            portal: "fotocasa",
            title: title || "(sin título)",
            price,
            url: href.startsWith("http") ? href : `https://www.fotocasa.es${href}`,
          });
        }
      } catch (e) {
        console.log(`[fotocasa] card parse error: ${(e as Error).message}`);
      }
    }

    console.log(`[fotocasa] extractedCards=${nodes.length} withId=${listings.length}`);
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
