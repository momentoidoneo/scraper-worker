import { chromium, type Browser, type BrowserContext } from "playwright";
import { buildHabitacliaUrl, type SearchParams } from "../lib/url-builder";
import { getProxyConfigFor } from "../lib/proxy";

export type Listing = {
  id: string;
  portal: "habitaclia";
  title: string;
  price: number | null;
  url: string;
  raw?: any;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function scrapeHabitaclia(params: SearchParams): Promise<Listing[]> {
  const url = buildHabitacliaUrl(params);
  const proxy = getProxyConfigFor("habitaclia");

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

    // Habitaclia: combinamos selectores actuales y antiguos.
    const selector =
      "article.list-item-container, article.list-item, li.list-item-container, [class*='list-item-container']";
    const nodes = await page.$$(selector);
    console.log(`[habitaclia] selector="${selector}" matchedNodes=${nodes.length}`);

    const listings: Listing[] = [];
    for (const node of nodes) {
      try {
        const id =
          (await node.getAttribute("data-id")) ||
          (await node.getAttribute("id")) ||
          "";
        const linkEl = await node.$("a[href*='.htm']");
        const href = (await linkEl?.getAttribute("href")) || "";
        const title =
          ((await (await node.$("h3, h2, .list-item-title, [class*='title']"))?.innerText()) || "").trim();

        const priceEl = await node.$(".list-item-price, [class*='price']");
        const priceText = (await priceEl?.innerText())?.replace(/[^\d]/g, "") || "";
        const price = priceText ? Number(priceText) : null;

        if (href || title) {
          const finalId = id || href.split("/").pop()?.replace(".htm", "") || crypto.randomUUID();
          listings.push({
            id: finalId,
            portal: "habitaclia",
            title: title || "(sin título)",
            price,
            url: href.startsWith("http") ? href : `https://www.habitaclia.com/${href.replace(/^\//, "")}`,
          });
        }
      } catch (e) {
        console.log(`[habitaclia] card parse error: ${(e as Error).message}`);
      }
    }

    console.log(`[habitaclia] extractedCards=${nodes.length} withId=${listings.length}`);
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
