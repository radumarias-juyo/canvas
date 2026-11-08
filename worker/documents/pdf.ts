import type { BrowserWorker, Page } from "@cloudflare/puppeteer";
import { CheckBrowser } from "../artifacts/browser.ts";

/** How long printing one document may take, once the browser has started (its start has the browser's own deadline). */
export const PRINT_MS = 20_000;

/**
 * Print `html` (documentHtml: the read-only view as one static page) to a PDF in `page`, a fresh page of the
 * headless browser. Nothing in it runs or loads: scripts are off, and every request but the page's own data: pictures
 * is refused (its policy refuses them first), so a document cannot make the browser reach anything.
 */
export async function printPdf(page: Page, html: string): Promise<Uint8Array<ArrayBuffer>> {
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith("data:")) void request.continue();
    else void request.abort("blockedbyclient");
  });
  await page.setContent(html, { waitUntil: "load", timeout: PRINT_MS });
  const pdf = await page.pdf({ format: "a4", printBackground: true, preferCSSPageSize: true, timeout: PRINT_MS });
  return new Uint8Array(pdf);
}

/**
 * Print `html` to a PDF in the deployment's headless browser (the BROWSER binding the page check uses), opened for this
 * one export and closed after. BrowserUnavailable without a binding, CheckTimedOut past PRINT_MS.
 */
export async function printDocument(binding: BrowserWorker | undefined, html: string): Promise<Uint8Array<ArrayBuffer>> {
  const browser = new CheckBrowser(binding);
  try {
    return await browser.withPage((page) => printPdf(page, html), { timeoutMs: PRINT_MS });
  } finally {
    browser.close();
  }
}
