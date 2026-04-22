import { newContext, humanDelay, humanScroll } from "../browser.js";

type Listing = {
  portal: "fotocasa";
  external_id: string;
  url: string;
  title?: string;
  price?: number;
  raw?: any;
};

export async function scrapeFotocasa(
  params: Record<string, any>,
  onBatch: (batch: Listing[]) => Promise<void>
): Promise<Listing[]> {
  // TODO: build URL from params. Fotocasa pattern: https://www.fotocasa.es/es/{operation}/{type}/{city}/...
  const url = `https://www.fotocasa.es/`;
  const { browser, context } = await newContext();
  const collected: Listing[] = [];
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await humanDelay(1000, 2500);

    const captcha = await page.$('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]');
    if (captcha) throw new Error("captcha_blocked");

    await humanScroll(page);

    // TODO: real selectors. Fotocasa uses div.re-Searchresult-item or similar.
    const cards = await page.$$eval("[data-test='listing-item'], article.re-Searchresult-item", (els: any[]) =>
      els.map((el) => ({
        external_id: el.getAttribute("data-id") ?? el.id ?? "",
        url: (el.querySelector("a") as HTMLAnchorElement | null)?.href ?? "",
        title: el.querySelector("h2,h3")?.textContent?.trim() ?? "",
      }))
    );

    const batch: Listing[] = cards
      .filter((c: any) => c.external_id)
      .map((c: any) => ({ portal: "fotocasa" as const, ...c }));

    if (batch.length) {
      collected.push(...batch);
      await onBatch(batch);
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return collected;
}
