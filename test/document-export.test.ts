import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentHtml, documentMarkdown, exportFileName, parseCsv } from "../shared/document-export.ts";
import { unzip } from "../shared/unzip.ts";
import type { DocNode } from "../shared/document.ts";
import { documentDocx, imageSize } from "../worker/documents/docx.ts";
import { printPdf } from "../worker/documents/pdf.ts";

const GOLDEN = new URL("./fixtures/documents/", import.meta.url);
/** UPDATE_GOLDEN=1 rewrites the golden files from what the exporters make now (review the diff before committing). */
function golden(name: string, actual: string): void {
  const path = new URL(name, GOLDEN);
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, actual);
  expect(actual).toBe(readFileSync(path, "utf8"));
}

/** A 2×1 red PNG. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwyBDABL8AX7Hf8NQAAAAABJRU5ErkJggg==";

const text = (value: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]): DocNode => ({
  type: "text",
  text: value,
  ...(marks.length && { marks: marks.map((mark) => (typeof mark === "string" ? { type: mark } : mark)) }),
});
const p = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
const li = (...content: DocNode[]): DocNode => ({ type: "listItem", content });

/** Every kind of block and mark the schema has. */
const SAMPLE: DocNode[] = [
  { type: "heading", attrs: { level: 1 }, content: [text("Plan")] },
  p(text("Plain, "), text("bold", "bold"), text(", "), text("italic", "italic"), text(", "), text("gone", "strike"), text(", "), text("x = 1", "code"), text(" and a "), text("link", { type: "link", attrs: { href: "https://example.com/a?b=1" } }), text(".")),
  p(text("Not a link", { type: "link", attrs: { href: "javascript:alert(1)" } }), text(" *stars* and | pipes")),
  p({ type: "mention", attrs: { id: "u1", label: "Ada" } }, text(" on "), { type: "date", attrs: { value: "2026-11-08" } }, text(": "), { type: "dropdown", attrs: { value: "Done" } }),
  { type: "heading", attrs: { level: 2 }, content: [text("Lists")] },
  { type: "bulletList", content: [li(p(text("one"))), li(p(text("two")), { type: "bulletList", content: [li(p(text("two-a")))] })] },
  { type: "orderedList", content: [li(p(text("first"))), li(p(text("second")))] },
  { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(text("done"))] }, { type: "taskItem", attrs: { checked: false }, content: [p(text("to do"))] }] },
  { type: "heading", attrs: { level: 3 }, content: [text("Data")] },
  {
    type: "table",
    content: [
      { type: "tableRow", content: [{ type: "tableHeader", content: [p(text("Name"))] }, { type: "tableHeader", content: [p(text("Status"))] }] },
      { type: "tableRow", content: [{ type: "tableCell", content: [p(text("Alpha"))] }, { type: "tableCell", content: [p({ type: "dropdown", attrs: { value: "Open" } })] }] },
    ],
  },
  { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;\nconsole.log(a);")] },
  { type: "csv", attrs: { text: 'city,people\n"Paris, FR",2100000' } },
  { type: "latex", attrs: { text: "e^{i\\pi} + 1 = 0" } },
  { type: "image", attrs: { src: PNG, alt: "A red dot" } },
  { type: "image", attrs: { src: "/api/files/secret.png", alt: "Owner's file" } },
  { type: "pending", attrs: { intent: "Risks" } },
  { type: "held" },
];

describe("document export", () => {
  it("makes Markdown from the block tree", () => {
    golden("sample.md", documentMarkdown("Quarter <plan>", SAMPLE));
  });

  it("makes Word with headings, lists with tasks, tables, code, pictures and links", async () => {
    const bytes = await documentDocx("Quarter <plan>", SAMPLE);
    const files = new Map((await unzip(bytes, { maxFiles: 100, maxFileBytes: 10_000_000, maxTotalBytes: 10_000_000 })).map((file) => [file.name, new TextDecoder().decode(file.bytes)]));
    const xml = files.get("word/document.xml")!;
    // The document's structure, without the ids Word gives runs and relationships: a line per paragraph, one per table row.
    const words = (part: string) => [...part.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join("");
    const outline = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)].map(([paragraph]) => {
      if (paragraph.startsWith("<w:tbl>")) {
        return [...paragraph.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)]
          .map(([row]) => `row: ${[...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(([cell]) => `${cell.includes('w:fill="F3F4F6"') ? "*" : ""}${words(cell)}`).join(" | ")}`)
          .join("\n");
      }
      const style = paragraph.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
      const numId = paragraph.match(/<w:numId w:val="(\d+)"\/>/)?.[1];
      const list = numId && `${numId}.${paragraph.match(/<w:ilvl w:val="(\d+)"\/>/)?.[1] ?? 0}`;
      const image = paragraph.includes("<w:drawing>") ? "[picture]" : "";
      const link = paragraph.includes("<w:hyperlink") ? " [link]" : "";
      const code = paragraph.includes('w:ascii="Consolas"') ? " [mono]" : "";
      return `${style ?? "p"}${list ? ` list=${list}` : ""}: ${words(paragraph)}${image}${link}${code}`;
    });
    golden("sample.docx.txt", `${outline.join("\n")}\n`);
    expect(xml).toContain("<w:tbl>");
    expect([...files.keys()].some((name) => /^word\/media\/.+\.png$/.test(name))).toBe(true);
    const rels = files.get("word/_rels/document.xml.rels")!;
    expect(rels).toContain('Target="https://example.com/a?b=1"');
    expect(rels).not.toContain("javascript:");
    expect(rels).not.toContain("secret.png");
  });

  it("prints HTML with no script and nothing to fetch", () => {
    const html = documentHtml("Quarter <plan>", SAMPLE);
    expect(html).toContain("<h1>Quarter &#60;plan&#62;</h1>");
    expect(html).not.toMatch(/<script|javascript:|secret\.png/);
    expect(html).toContain("default-src 'none'");
  });

  it("names the file from the title, never a path", () => {
    expect(exportFileName("Q3 / plan: draft", "docx")).toBe("Q3 plan draft.docx");
    expect(exportFileName("../../etc/passwd", "md")).toBe("etc passwd.md");
    expect(exportFileName("", "pdf")).toBe("Document.pdf");
  });

  it("reads CSV and picture sizes", () => {
    expect(parseCsv('a,"b, c"\n"d ""e""",f')).toEqual([
      ["a", "b, c"],
      ['d "e"', "f"],
    ]);
    expect(imageSize(Uint8Array.from(atob(PNG.split(",")[1]), (c) => c.charCodeAt(0)))).toEqual({ width: 2, height: 1, type: "png" });
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

  it("prints the read-only view to a PDF, reaching nothing", async () => {
    const page = await browser.newPage();
    const asked: string[] = [];
    page.on("request", (request) => asked.push(request.url()));
    try {
      const html = documentHtml("Quarter plan", [...SAMPLE, { type: "paragraph", content: [text("tail")] }]).replace(
        "</body>",
        '<img src="https://example.com/track.png"><link rel="stylesheet" href="https://example.com/x.css"></body>',
      );
      const pdf = await printPdf(page, html);
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(5_000);
      // The policy already refuses them; whatever was asked for went nowhere.
      expect(asked.filter((url) => !url.startsWith("data:") && url !== "about:blank")).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
