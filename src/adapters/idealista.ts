import { chromium, type Browser, type BrowserContext } from "playwright";
import { buildIdealistaUrl, type SearchParams } from "../lib/url-builder";
import { getProxyConfigFor } from "../lib/proxy";

export type Listing = {
  id: string;
  portal: "idealista";
  title: string;
  price: number | null;
  url: string;
  raw?: any;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function scrapeIdealista(params: SearchParams): Promise<Listing[]> {
  const url = buildIdealistaUrl(params);
  const proxy = getProxyConfigFor("idealista");

  console.log(
    `[idealista] goto url=${url} params=${JSON.stringify(params)} proxy=${
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

    console.log(`[idealista] status=${status} finalUrl=${finalUrl} htmlBytes=${bytes}`);
    console.log(`[idealista] htmlPreview=${html.slice(0, 500).replace(/\n/g, " ")}`);

    const lower = html.toLowerCase();
    const blockHints: string[] = [];
    if (lower.includes("captcha")) blockHints.push("captcha");
    if (lower.includes("datadome")) blockHints.push("datadome");
    if (lower.includes("are you a human")) blockHints.push("are-you-human");
    if (status === 403) blockHints.push("http-403");
    if (blockHints.length) {
      console.log(`[idealista] blockHints=${blockHints.join("|")}`);
    }

    // Idealista usa article.item dentro de la lista de resultados.
    const selector = "article.item";
    const nodes = await page.$$(selector);
    console.log(`[idealista] selector="${selector}" matchedNodes=${nodes.length}`);

    const listings: Listing[] = [];
    for (const node of nodes) {
      try {
        const id = (await node.getAttribute("data-element-id")) || (await node.getAttribute("id")) || "";
        const titleEl = await node.$("a.item-link");
        const title = (await titleEl?.innerText())?.trim() || "";
        const href = (await titleEl?.getAttribute("href")) || "";
        const priceEl = await node.$(".item-price, .price-row .item-price");
        const priceText = (await priceEl?.innerText())?.replace(/[^\d]/g, "") || "";
        const price = priceText ? Number(priceText) : null;

        if (id && title) {
          listings.push({
            id,
            portal: "idealista",
            title,
            price,
            url: href.startsWith("http") ? href : `https://www.idealista.com${href}`,
          });
        }
      } catch (e) {
        console.log(`[idealista] card parse error: ${(e as Error).message}`);
      }
    }

    console.log(`[idealista] extractedCards=${nodes.length} withId=${listings.length}`);
    if (listings.length === 0) {
      console.log(
        `[idealista] no listings extracted (selector may be stale or page is a captcha/empty shell)`
      );
    }
    console.log(`[idealista] finished collected=${listings.length}`);
    return listings;
  } catch (err) {
    console.error(`[idealista] FATAL`, err);
    throw err;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
