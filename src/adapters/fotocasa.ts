import { newContext, humanDelay, humanScroll } from "../browser.js";

type Listing = {
  portal: "fotocasa";
  external_id: string;
  url: string;
  title?: string;
  price?: number;
  raw?: any;
};

const PORTAL = "fotocasa";

export async function scrapeFotocasa(
  params: Record<string, any>,
  onBatch: (batch: Listing[]) => Promise<void>
): Promise<Listing[]> {
  const url = `https://www.fotocasa.es/`;
  console.log(`[${PORTAL}] goto url=${url} params=${JSON.stringify(params)}`);

  const { browser, context } = await newContext();
  const collected: Listing[] = [];
  try {
    const page = await context.newPage();

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = response?.status() ?? 0;
    const finalUrl = page.url();
    const html = await page.content();
    const htmlLen = html.length;
    const preview = html.slice(0, 500).replace(/\s+/g, " ");
    console.log(`[${PORTAL}] status=${status} finalUrl=${finalUrl} htmlBytes=${htmlLen}`);
    console.log(`[${PORTAL}] htmlPreview=${preview}`);

    const lower = html.toLowerCase();
    const blockHints = [
      "captcha", "datadome", "are you a human", "acceso denegado",
      "access denied", "px-captcha", "cf-chl", "incapsula",
    ].filter((h) => lower.includes(h));
    if (blockHints.length) {
      console.warn(`[${PORTAL}] blockHints=${blockHints.join("|")}`);
    }

    const captcha = await page.$('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]');
    if (captcha) {
      console.error(`[${PORTAL}] captcha element detected, aborting`);
      throw new Error("captcha_blocked");
    }

    await humanDelay(1000, 2500);
    await humanScroll(page);

    const selector = "[data-test='listing-item'], article.re-Searchresult-item";
    const rawCount = await page.locator(selector).count().catch(() => 0);
    console.log(`[${PORTAL}] selector="${selector}" matchedNodes=${rawCount}`);

    const cards = await page.$$eval(selector, (els: any[]) =>
      els.map((el) => ({
        external_id: el.getAttribute("data-id") ?? el.id ?? "",
        url: (el.querySelector("a") as HTMLAnchorElement | null)?.href ?? "",
        title: el.querySelector("h2,h3")?.textContent?.trim() ?? "",
      }))
    );
    console.log(`[${PORTAL}] extractedCards=${cards.length} withId=${cards.filter((c: any) => c.external_id).length}`);

    const batch: Listing[] = cards
      .filter((c: any) => c.external_id)
      .map((c: any) => ({ portal: "fotocasa" as const, ...c }));

    if (batch.length) {
      collected.push(...batch);
      await onBatch(batch);
      console.log(`[${PORTAL}] emitted batch size=${batch.length}`);
    } else {
      console.warn(`[${PORTAL}] no listings extracted (selector may be stale or page is a captcha/empty shell)`);
    }
  } catch (e) {
    const err = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    console.error(`[${PORTAL}] EXCEPTION ${err}`);
    throw e;
  } finally {
    await context.close();
    await browser.close();
    console.log(`[${PORTAL}] finished collected=${collected.length}`);
  }
  return collected;
}
