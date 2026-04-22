import { chromium as baseChromium } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { getProxyConfig } from "./proxy.js";

chromium.use(StealthPlugin() as any);

const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

export async function newContext() {
  const proxy = getProxyConfig();
  const browser = await (chromium as any).launch({ headless: true, proxy });
  const context = await browser.newContext({
    userAgent: UA_POOL[Math.floor(Math.random() * UA_POOL.length)],
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    viewport: { width: 1366, height: 768 },
  });
  return { browser, context };
}

export async function humanDelay(min = 200, max = 800) {
  const ms = min + Math.random() * (max - min);
  await new Promise((r) => setTimeout(r, ms));
}

export async function humanScroll(page: any, steps = 8) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 300 + Math.random() * 400);
    await humanDelay(300, 900);
  }
}

// Re-export raw playwright in case adapters need it
export { baseChromium };
