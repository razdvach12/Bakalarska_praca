import { chromium, Browser, Page } from "playwright";

let browser: Browser | null = null;
let page: Page | null = null;

// TOTO VRATI ZDIELANU INSTANCIU PLAYWRIGHT STRANKY
export async function getPage() {
  if (!browser) {
    browser = await chromium.launch({ headless: false });
  }
  if (!page) {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  }
  return page;
}
