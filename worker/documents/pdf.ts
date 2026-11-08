import type { Page } from "@cloudflare/puppeteer";

/** How long printing one document may take before it gives up (the browser's own start is the caller's deadline). */
export const PRINT_MS = 20_000;

/**
 * Print `html` (documentHtml: the read-only view as one static page) to a PDF in `page`, a fresh page of the
 * headless browser the page check uses. Nothing in it runs or loads: scripts are off, and every request but the page's
 * own data: pictures is refused, so a document cannot make the browser reach anything.
 */
export async function printPdf(page: Page, html: string): Promise<Uint8Array> {
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
