import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentHtml, documentMarkdown, exportFileName, parseCsv } from "../shared/document-export.ts";
import { checkDocument, type DocMark, type DocNode } from "../shared/document.ts";
import { unzip } from "../shared/unzip.ts";
import { documentDocx, imageSize } from "../worker/documents/docx.ts";
import { documentExportRoute, withImages, type ExportReach, type ExportView } from "../worker/documents/export-route.ts";
import { BrowserUnavailable } from "../worker/artifacts/browser.ts";
import { printDocument, printPdf } from "../worker/documents/pdf.ts";

const GOLDEN = new URL("./fixtures/documents/", import.meta.url);
/** UPDATE_GOLDEN=1 rewrites the golden files from what the exporters make now (review the diff before committing). */
function golden(name: string, actual: string): void {
  const path = new URL(name, GOLDEN);
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, actual);
  expect(actual).toBe(readFileSync(path, "utf8"));
}

/** A 2×1 red PNG. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwyBDABL8AX7Hf8NQAAAAABJRU5ErkJggg==";

const text = (value: string, ...marks: (DocMark["type"] | DocMark)[]): DocNode => ({
  type: "text",
  text: value,
  ...(marks.length && { marks: marks.map((mark) => (typeof mark === "string" ? { type: mark } : mark)) }),
});
const p = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
const li = (...content: DocNode[]): DocNode => ({ type: "listItem", content });
const cell = (type: "tableCell" | "tableHeader", ...content: DocNode[]): DocNode => ({ type, content: [p(...content)] });

/** Every kind of block, mark and chip the schema has, held by its own check (ids given, hashes computed). */
const SAMPLE: DocNode[] = checkDocument(
  {
    title: "Quarter <plan>",
    rev: 3,
    tabs: [
      {
        id: "t1",
        title: "Tab 1",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [text("Plan")] },
          p(
            text("Plain, "),
            text("bold", "bold"),
            text(", "),
            text("italic", "italic"),
            text(", "),
            text("gone", "strike"),
            text(", "),
            text("x = 1", "code"),
            text(" and a "),
            text("link", { type: "link", attrs: { href: "https://example.com/a?b=1" } }),
            text("."),
          ),
          p(text("Not *emphasis*, | pipes, # hash, $5 and 1. not a list")),
          p({ type: "mention", attrs: { uid: "u1", name: "Ada" } }, text(" on "), { type: "date", attrs: { value: "2026-11-08" } }, text(": "), {
            type: "dropdown",
            attrs: { options: ["Open", "Done"], value: "Done" },
          }),
          { type: "heading", attrs: { level: 2 }, content: [text("Lists")] },
          { type: "bulletList", content: [li(p(text("one"))), li(p(text("two")), p(text("two, more")), { type: "bulletList", content: [li(p(text("two-a")))] })] },
          { type: "orderedList", attrs: { start: 3 }, content: [li(p(text("third"))), li(p(text("fourth")), { type: "orderedList", content: [li(p(text("fourth-a")))] })] },
          { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(text("done"))] }, { type: "taskItem", content: [p(text("to do"))] }] },
          { type: "heading", attrs: { level: 3 }, content: [text("Data")] },
          {
            type: "table",
            content: [
              { type: "tableRow", content: [cell("tableHeader", text("Name")), cell("tableHeader", text("Status"))] },
              { type: "tableRow", content: [cell("tableCell", text("Alpha "), text("a|b", "code")), cell("tableCell", { type: "dropdown", attrs: { options: ["Open", "Done"], value: "Open" } })] },
            ],
          },
          { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;\nconsole.log(`${a}`);")] },
          { type: "csv", content: [text('city,people\n"Paris, FR",2100000')] },
          { type: "latex", content: [text("e^{i\\pi} + 1 = 0")] },
          { type: "image", attrs: { src: "image:dot", alt: "A red dot" } },
          { type: "image", attrs: { src: "image:missing", alt: "Not carried" } },
          { type: "embed", attrs: { kind: "chart", spec: "{}", title: "Sales" } },
          { type: "pending", attrs: { intent: "Risks" } },
        ],
      },
    ],
  },
  { assignIds: true },
).tabs[0]!.content;

/** What exportView carries for the sample: the one picture it has the bytes of. */
const IMAGES = { "image:dot": PNG };
const BLOCKS = withImages(SAMPLE, IMAGES);

describe("document export", () => {
  it("makes Markdown from the block tree", () => {
    golden("sample.md", documentMarkdown("Quarter <plan>", BLOCKS));
  });

  it("makes Markdown a GFM reader reads back as the same structure", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, documentMarkdown("Quarter <plan>", BLOCKS)));
    expect(html).toContain("<h1>Quarter &lt;plan&gt;</h1>");
    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain("<h4>Data</h4>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('<a href="https://example.com/a?b=1">link</a>');
    // Escaped text stays text.
    expect(html).toContain("<p>Not *emphasis*, | pipes, # hash, $5 and 1. not a list</p>");
    // Lists: the ordered one from 3 with its own nested list, the tasks as checkboxes.
    expect(html).toMatch(/<ol start="3">\s*<li>third<\/li>\s*<li>fourth\s*<ol>\s*<li>fourth-a<\/li>/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    // Both tables keep their two columns, the code with a pipe in its cell.
    expect(html).toContain("<td>Alpha <code>a|b</code></td>");
    expect(html.match(/<table>/g)).toHaveLength(2);
    expect(html).toContain("<td>Paris, FR</td>");
    expect(html).toContain('<code class="language-ts">');
  });

  it("makes Word with headings, lists with tasks, tables, code, pictures and links", async () => {
    const bytes = await documentDocx("Quarter <plan>", BLOCKS);
    const files = new Map(
      (await unzip(bytes, { maxFiles: 100, maxFileBytes: 10_000_000, maxTotalBytes: 10_000_000 })).map((file) => [file.name, new TextDecoder().decode(file.bytes)]),
    );
    const xml = files.get("word/document.xml")!;
    // The document's structure, without the ids Word gives runs and relationships: a line per paragraph, one per table row.
    const words = (part: string) => [...part.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join("");
    const outline = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)].map(([part]) => {
      if (part.startsWith("<w:tbl>")) {
        return [...part.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)]
          .map(([row]) => `row: ${[...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(([one]) => `${one.includes('w:fill="F3F4F6"') ? "*" : ""}${words(one)}`).join(" | ")}`)
          .join("\n");
      }
      const style = part.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
      const numId = part.match(/<w:numId w:val="(\d+)"\/>/)?.[1];
      const list = numId && `${numId}.${part.match(/<w:ilvl w:val="(\d+)"\/>/)?.[1] ?? 0}`;
      const indent = !numId && part.match(/<w:ind w:left="(\d+)"/)?.[1];
      const image = part.includes("<w:drawing>") ? "[picture]" : "";
      const link = part.includes("<w:hyperlink") ? " [link]" : "";
      const code = part.includes('w:ascii="Consolas"') ? " [mono]" : "";
      return `${style ?? "p"}${list ? ` list=${list}` : ""}${indent ? ` indent=${indent}` : ""}: ${words(part)}${image}${link}${code}`;
    });
    golden("sample.docx.txt", `${outline.join("\n")}\n`);
    expect([...files.keys()].some((name) => /^word\/media\/.+\.png$/.test(name))).toBe(true);
    // The ordered list starts at 3, as in the document.
    expect(files.get("word/numbering.xml")).toContain('<w:start w:val="3"/>');
    const rels = files.get("word/_rels/document.xml.rels")!;
    expect(rels).toContain('Target="https://example.com/a?b=1"');
    expect(rels).not.toContain("image:");
  });

  it("prints HTML with no script and nothing to fetch", () => {
    const html = documentHtml("Quarter <plan>", BLOCKS);
    expect(html).toContain("<h1>Quarter &#60;plan&#62;</h1>");
    expect(html).not.toMatch(/<script|image:missing/);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`<img src="${PNG}" alt="A red dot">`);
  });

  it("leaves a link out unless it is http(s) or mail, and keeps line breaks", () => {
    const blocks: DocNode[] = [p(text("run", { type: "link", attrs: { href: "javascript:alert(1)" } }), { type: "hardBreak" }, text("next"))];
    expect(documentMarkdown("T", blocks)).toBe("# T\n\nrun\\\nnext\n");
    expect(documentHtml("T", blocks)).toContain("<p>run<br>next</p>");
  });

  it("swaps each picture for the bytes the view carries, and nothing else", () => {
    const [carried, missing] = withImages(SAMPLE, IMAGES).filter((block) => block.type === "image");
    expect(carried!.attrs!.src).toBe(PNG);
    expect(missing!.attrs!.src).toBe("image:missing");
    // Only bytes carried in the file go in: a picture swapped for an address is its alt text in every format.
    const fetched = withImages(SAMPLE, { "image:dot": "https://example.com/track.png" });
    expect(documentMarkdown("T", fetched)).not.toContain("example.com/track");
    expect(documentHtml("T", fetched)).not.toContain("example.com/track");
  });

  it("names the file from the title, never a path", () => {
    expect(exportFileName("Q3 / plan: draft", "docx")).toBe("Q3 plan draft.docx");
    expect(exportFileName("../../etc/passwd", "md")).toBe("etc passwd.md");
    expect(exportFileName("Résumé", "pdf")).toBe("Résumé.pdf");
    expect(exportFileName("", "pdf")).toBe("Document.pdf");
  });

  it("reads CSV and picture sizes", () => {
    expect(parseCsv('a,"b, c"\n"d ""e""",f')).toEqual([
      ["a", "b, c"],
      ['d "e"', "f"],
    ]);
    expect(imageSize(Uint8Array.from(atob(PNG.split(",")[1]!), (c) => c.charCodeAt(0)))).toEqual({ width: 2, height: 1, type: "png" });
  });
});

describe("the export route", () => {
  const VIEW: ExportView = { title: "Quarter plan", blocks: SAMPLE, images: IMAGES };
  const asked: string[] = [];
  const reach = (view: ExportReach["view"] = async () => VIEW): ExportReach => ({
    view: async (docId) => (asked.push(docId), view(docId)),
    print: async (html) => new TextEncoder().encode(`%PDF-fake ${html.length}`),
  });
  const get = (path: string, method = "GET") => new Request(`https://app.test${path}`, { method });

  it("serves each format as a download of the reader's view", async () => {
    const md = (await documentExportRoute(get("/api/documents/doc12345/export?format=md"), reach()))!;
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("content-disposition")).toBe(`attachment; filename="Quarter plan.md"; filename*=UTF-8''Quarter%20plan.md`);
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    expect(md.headers.get("cache-control")).toBe("private, no-store");
    expect(await md.text()).toBe(documentMarkdown("Quarter plan", BLOCKS));

    const docx = (await documentExportRoute(get("/api/documents/doc12345/export?format=docx"), reach()))!;
    expect(docx.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(new Uint8Array(await docx.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));

    const pdf = (await documentExportRoute(get("/api/documents/doc12345/export?format=pdf"), reach()))!;
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(await pdf.text()).toMatch(/^%PDF-fake \d+$/);
  });

  it("answers as the object does when the reader may not have it", async () => {
    asked.length = 0;
    const refused = (await documentExportRoute(get("/api/documents/doc12345/export?format=pdf"), reach(async () => ({ status: 404, error: "No such document" }))))!;
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "No such document" });
    expect(asked).toEqual(["doc12345"]);
  });

  it("asks the object for nothing on a bad id, format or method, and leaves other paths alone", async () => {
    asked.length = 0;
    expect((await documentExportRoute(get("/api/documents/doc12345/export?format=html"), reach()))!.status).toBe(400);
    expect((await documentExportRoute(get("/api/documents/doc12345/export"), reach()))!.status).toBe(400);
    expect((await documentExportRoute(get("/api/documents/..%2Fx/export?format=md"), reach()))!.status).toBe(404);
    expect((await documentExportRoute(get("/api/documents/doc12345/export?format=md", "POST"), reach()))!.status).toBe(405);
    expect(asked).toEqual([]);
    expect(await documentExportRoute(get("/api/documents/doc12345"), reach())).toBeNull();
  });

  it("has no PDF without a browser binding", async () => {
    await expect(printDocument(undefined, "<p>x</p>")).rejects.toBeInstanceOf(BrowserUnavailable);
  });

  it("says so when a file cannot be made", async () => {
    const broken: ExportReach = { view: async () => VIEW, print: async () => Promise.reject(new Error("no browser")) };
    const response = (await documentExportRoute(get("/api/documents/doc12345/export?format=pdf"), broken))!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The PDF could not be made: no browser" });
  });
});

/** A local Chrome to print in: CHROME_PATH, else the one Playwright installs. Without one the PDF test skips. */
function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d))) {
    const path = `${root}/${dir}/chrome-linux64/chrome`;
    if (existsSync(path)) return path;
  }
  return undefined;
}

const chrome = chromePath();

describe.skipIf(!chrome)("document PDF in Chrome", () => {
  let chromeProcess: ChildProcess;
  let browser: Browser;

  beforeAll(async () => {
    chromeProcess = spawn(chrome!, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      chromeProcess.stderr!.on("data", (chunk) => {
        output += chunk;
        const found = output.match(/ws:\/\/\S+/);
        if (found) resolve(found[0]);
      });
      chromeProcess.on("exit", () => reject(new Error(`Chrome exited: ${output}`)));
    });
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  }, 30_000);

  afterAll(async () => {
    await browser?.disconnect().catch(() => {});
    chromeProcess?.kill();
  });

  it("prints the read-only view to a PDF, running and reaching nothing", async () => {
    const page = await browser.newPage();
    const asked: string[] = [];
    page.on("request", (request) => asked.push(request.url()));
    try {
      // What a document cannot hold, put in anyway: a script, and things to fetch.
      const html = documentHtml("Quarter plan", BLOCKS).replace(
        "</body>",
        '<script>document.title = "ran"</script><img src="https://example.com/track.png"><link rel="stylesheet" href="https://example.com/x.css"></body>',
      );
      const pdf = await printPdf(page, html);
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(5_000);
      expect(await page.title()).toBe("Quarter plan");
      expect(asked.filter((url) => !url.startsWith("data:") && url !== "about:blank")).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
