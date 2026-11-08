// What the document's blocks and chips show, as plain functions the tests read without a browser.

/** CSV text as rows of cells: commas split cells, a quoted cell may hold commas, "" and new lines. Empty lines go. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((each) => each !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((each) => each !== "")) rows.push(row);
  return rows;
}

/** A date chip's value (YYYY-MM-DD) as the reader reads dates: "Nov 20, 2026"; the value itself when it is not a date. */
export function dateLabel(value: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value || "No date";
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Today as a date chip's value, in the reader's own day. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A dropdown's options as typed ("Open, In progress, Done"): trimmed, without empties or repeats. */
export function dropdownOptions(typed: string): string[] {
  return [...new Set(typed.split(",").map((option) => option.trim()).filter(Boolean))];
}
