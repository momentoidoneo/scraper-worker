import { newContext, humanDelay, humanScroll } from "../browser.js";

type Listing = {
  portal: "idealista";
  external_id: string;
  url: string;
  title?: string;
  price?: number;
  surface?: number;
  rooms?: number;
  bathrooms?: number;
  zone?: string;
  city?: string;
  raw?: any;
};

export async function scrapeIdealista(
  params: Record<string, any>,
  onBatch: (batch: Listing[]) => Promise<void>
): Promise<Listing[]> {
  // TODO: Build the search URL from `params` (operation, propertyTypes, city, zones, priceMin/Max, etc.)
  // Idealista pattern: https://www.idealista.com/{operation}/{propertyType}/{city}/{zone}/...
  const url = `https://www.idealista.com/`;

  const { browser, context } = await newContext();
  const collected: Listing[] = [];
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await humanDelay(1000, 2500);

    // CAPTCHA detection
    const captcha = await page.$('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], #px-captcha');
    if (captcha) throw new Error("captcha_blocked");

    await humanScroll(page);

    // TODO: replace with real selectors. Idealista cards live under article.item with data-element-id.
    const cards = await page.$$eval("article.item", (els: any[]) =>
      els.map((el) => ({
        external_id: el.getAttribute("data-element-id") ?? "",
        url: (el.querySelector("a.item-link") as HTMLAnchorElement | null)?.href ?? "",
        title: el.querySelector("a.item-link")?.textContent?.trim() ?? "",
      }))
    );

    const batch: Listing[] = cards
      .filter((c: any) => c.external_id)
      .map((c: any) => ({ portal: "idealista" as const, ...c }));

    if (batch.length) {
      collected.push(...batch);
      await onBatch(batch);
    }

    // TODO: paginate (next page link, ?pagina=N), rate-limit REQUEST_DELAY_MS between pages.
  } finally {
    await context.close();
    await browser.close();
  }
  return collected;
}
