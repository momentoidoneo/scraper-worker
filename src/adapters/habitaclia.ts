import { newContext, humanDelay, humanScroll } from "../browser.js";

type Listing = {
  portal: "habitaclia";
  external_id: string;
  url: string;
  title?: string;
  raw?: any;
};

export async function scrapeHabitaclia(
  params: Record<string, any>,
  onBatch: (batch: Listing[]) => Promise<void>
): Promise<Listing[]> {
  // TODO: Habitaclia pattern: https://www.habitaclia.com/{operation}-{city}.htm
  const url = `https://www.habitaclia.com/`;
  const { browser, context } = await newContext();
  const collected: Listing[] = [];
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await humanDelay(1000, 2500);

    const captcha = await page.$('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]');
    if (captcha) throw new Error("captcha_blocked");

    await humanScroll(page);

    // TODO: real selectors. Habitaclia uses article.list-item-container.
    const cards = await page.$$eval("article.list-item-container", (els: any[]) =>
      els.map((el) => ({
        external_id: el.getAttribute("data-id") ?? "",
        url: (el.querySelector("a.list-item-title") as HTMLAnchorElement | null)?.href ?? "",
        title: el.querySelector("a.list-item-title")?.textContent?.trim() ?? "",
      }))
    );

    const batch: Listing[] = cards
      .filter((c: any) => c.external_id)
      .map((c: any) => ({ portal: "habitaclia" as const, ...c }));

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
