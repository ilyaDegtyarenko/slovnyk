import Papa, { type ParseError } from "papaparse";
import { z } from "zod";

export type Word = {
  id: string;
  term: string;
  translation: string;
  example: string;
  tags: string[];
  added: string;
};

export type InvalidRow = {
  row: number;
  issues: string[];
};

export type SheetParseResult = {
  words: Word[];
  invalid: InvalidRow[];
  syncedAt: string;
};

export type SheetError =
  | { code: "SHEET_CSV_URL_MISSING"; message: string }
  | { code: "SHEET_CSV_URL_INVALID"; message: string }
  | { code: "SHEET_NOT_PUBLISHED"; message: string }
  | { code: "SHEET_UNREACHABLE"; message: string };

export type SheetFetchResult =
  | { ok: true; sheet: SheetParseResult }
  | { ok: false; error: SheetError };

const WordRow = z.object({
  id: z.string().trim().min(1),
  term: z.string().trim().min(1),
  translation: z.string().trim().min(1),
  example: z.string().trim().optional().default(""),
  tags: z.string().trim().optional().default(""),
  added: z.string().trim().optional().default(""),
});

// The sheet may carry helper columns beside these (SPEC §3.2) — zod strips them from the
// parsed word, and every judgement about a row looks only at this list.
const DOCUMENTED_COLUMNS = WordRow.keyof().options;
const DOCUMENTED_COLUMN_NAMES = new Set<string>(DOCUMENTED_COLUMNS);

const PUBLISH_STEPS = "File → Publish to web → sheet: Words → CSV";

const REVALIDATE_SECONDS = 300;

// Row numbers are the ones Google Sheets shows in its gutter, so the reader of /health can
// jump straight to the offending row: the header is row 1 and the first data row is row 2.
const HEADER_ROW = 1;
const FIRST_DATA_ROW = HEADER_ROW + 1;

export function looksLikeHtml(text: string): boolean {
  // A published CSV starts with the header row; markup means Google answered with a
  // sign-in or error page instead of the sheet.
  return text.trimStart().startsWith("<");
}

export function parseSheetCsv(
  csvText: string,
  syncedAt: string,
): SheetParseResult {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const issuesByRow = new Map<number, string[]>();
  const addIssue = (row: number, issue: string): void => {
    const issues = issuesByRow.get(row);
    if (issues) {
      issues.push(issue);
      return;
    }
    issuesByRow.set(row, [issue]);
  };

  const lastDataRowIndex = parsed.data.length - 1;
  for (const parseError of parsed.errors) {
    addIssue(sheetRowOfParseError(parseError, lastDataRowIndex), parseError.message);
  }

  const words: Word[] = [];
  const rowOfFirstUse = new Map<string, number>();
  const lastRowWithContent = findLastRowWithContent(parsed.data);
  // Only a sheet that actually has helper columns can blame its tail on them.
  const hasHelperColumns = (parsed.meta.fields ?? []).some(
    (field) => !DOCUMENTED_COLUMN_NAMES.has(field),
  );

  parsed.data.forEach((rawRow, dataRowIndex) => {
    const row = dataRowIndex + FIRST_DATA_ROW;

    if (isEmptyRow(rawRow)) {
      // Rows below the last word exist only because a helper column's formula reaches
      // down there and widens the published range. Without that column Google would not
      // have published them, so they are dropped as if it had not.
      if (hasHelperColumns && dataRowIndex > lastRowWithContent) {
        return;
      }

      // A gap between words earns one plain sentence rather than a complaint about every
      // required column being too short.
      addIssue(row, "Row is empty. Delete it in the sheet or fill it in.");
      return;
    }

    const validated = WordRow.safeParse(rawRow);

    if (!validated.success) {
      for (const issue of validated.error.issues) {
        const field = issue.path.map(String).join(".");
        addIssue(row, field ? `${field}: ${issue.message}` : issue.message);
      }
      return;
    }

    if (issuesByRow.has(row)) {
      // The row is structurally broken, so its columns may be shifted; keeping it would
      // silently attach the wrong translation to a word. Zod accepted this one, so without
      // a sentence naming the term the tutor cannot tell which word went missing.
      addIssue(
        row,
        `Skipped "${validated.data.term}": the row is malformed, so its columns may be shifted and the translation could be wrong. Fix the row in the sheet.`,
      );
      return;
    }

    const firstUse = rowOfFirstUse.get(validated.data.id);
    if (firstUse !== undefined) {
      addIssue(
        row,
        `Duplicate id "${validated.data.id}", already used in row ${firstUse}. The earlier row is kept.`,
      );
      return;
    }

    rowOfFirstUse.set(validated.data.id, row);
    words.push({
      id: validated.data.id,
      term: validated.data.term,
      translation: validated.data.translation,
      example: validated.data.example,
      tags: splitTags(validated.data.tags),
      added: validated.data.added,
    });
  });

  const invalid = [...issuesByRow]
    .map(([row, issues]) => ({ row, issues }))
    .sort((left, right) => left.row - right.row);

  return { words, invalid, syncedAt };
}

export async function fetchSheet(options: {
  fresh: boolean;
}): Promise<SheetFetchResult> {
  const csvUrl = process.env.SHEET_CSV_URL?.trim();
  if (!csvUrl) {
    return {
      ok: false,
      error: {
        code: "SHEET_CSV_URL_MISSING",
        message: `SHEET_CSV_URL is not set. Take the published CSV URL from ${PUBLISH_STEPS} and put it in .env.local.`,
      },
    };
  }

  if (!isHttpUrl(csvUrl)) {
    return {
      ok: false,
      error: {
        code: "SHEET_CSV_URL_INVALID",
        // The value itself is the one secret this app has, so it is never echoed back.
        message: `SHEET_CSV_URL is not a valid http(s) URL. Replace it with the address from ${PUBLISH_STEPS}.`,
      },
    };
  }

  let csvText: string;
  let syncedAt: string;
  try {
    const response = await fetch(
      csvUrl,
      options.fresh
        ? { cache: "no-store" }
        : { next: { revalidate: REVALIDATE_SECONDS } },
    );

    // Google serves an unpublished sheet as 404 with an HTML page, so the content type has
    // to outrank the status. An HTML page with a 5xx is Google being down and 429 is Google
    // throttling — in either case telling the owner to publish a sheet that is already
    // published wastes their evening.
    if (response.status >= 500 || response.status === 429) {
      return { ok: false, error: unreachableError(statusDetail(response)) };
    }

    if (response.headers.get("content-type")?.includes("text/html")) {
      return { ok: false, error: notPublishedError(response) };
    }

    if (!response.ok) {
      return { ok: false, error: unreachableError(statusDetail(response)) };
    }

    const body = await response.text();

    // A published sheet can still answer 200 with a sign-in page, so the body is the last
    // check before it is treated as CSV.
    if (looksLikeHtml(body)) {
      return { ok: false, error: notPublishedError(response) };
    }

    csvText = body;
    syncedAt = syncedAtOf(response);
  } catch (cause) {
    return { ok: false, error: unreachableError(describeCause(cause, csvUrl)) };
  }

  return { ok: true, sheet: parseSheetCsv(csvText, syncedAt) };
}

function sheetRowOfParseError(
  parseError: ParseError,
  lastDataRowIndex: number,
): number {
  // An error papaparse cannot pin to a row is about the file as a whole, so the header
  // carries it.
  if (parseError.row === undefined || lastDataRowIndex < 0) {
    return HEADER_ROW;
  }

  // Quote errors are counted in physical lines, so they include the header and sit one
  // ahead of the field-count errors, which count from the first data row. An unterminated
  // quote also swallows the rest of the file and reports a line past the last parsed row,
  // while the row whose content is broken is the last one parsed.
  const dataRowIndex =
    parseError.type === "Quotes" ? parseError.row - 1 : parseError.row;

  return Math.min(Math.max(dataRowIndex, 0), lastDataRowIndex) + FIRST_DATA_ROW;
}

function isEmptyRow(rawRow: Record<string, unknown>): boolean {
  // A helper column's content never speaks for a word, so it cannot make a row that says
  // no word look like it says one. A documented column that is missing outright is a
  // header problem, not a blank cell — a sheet whose header names none of the documented
  // columns must read as broken rows, never as a clean empty sheet.
  return DOCUMENTED_COLUMNS.every((column) => {
    const value = rawRow[column];
    return typeof value === "string" && value.trim() === "";
  });
}

function findLastRowWithContent(rows: Record<string, unknown>[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!isEmptyRow(rows[index])) {
      return index;
    }
  }
  return -1;
}

function syncedAtOf(response: Response): string {
  // Next replays a cached response for up to five minutes, so request time would claim a
  // sync that never happened. The `date` header travels with the cached body and names the
  // moment Google actually answered, which is what the user needs to judge staleness.
  const servedAt = response.headers.get("date");
  const answeredAt = servedAt === null ? Number.NaN : Date.parse(servedAt);

  // A proxy with a broken clock must not date the sync in the future, or every staleness
  // comparison built on this value inverts.
  return Number.isNaN(answeredAt)
    ? new Date().toISOString()
    : new Date(Math.min(answeredAt, Date.now())).toISOString();
}

function statusDetail(response: Response): string {
  return `the sheet URL answered with HTTP ${response.status} ${response.statusText}`.trimEnd();
}

function splitTags(tags: string): string[] {
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function describeCause(cause: unknown, csvUrl: string): string {
  const error = cause instanceof Error ? cause : undefined;
  // A failed fetch reports a bare "fetch failed" and keeps the reason worth reading —
  // ENOTFOUND, ECONNREFUSED — on the nested cause.
  const nested = error?.cause instanceof Error ? error.cause : undefined;
  const message = nested?.message ?? error?.message ?? String(cause);

  // Some failures quote the request URL back, and that URL is the one secret this app has.
  return message.split(csvUrl).join("the configured sheet URL");
}

function unreachableError(detail: string): SheetError {
  return {
    code: "SHEET_UNREACHABLE",
    message: `Could not read the word list: ${detail}. Check the network connection and that SHEET_CSV_URL still points at the published sheet.`,
  };
}

function notPublishedError(response: Response): SheetError {
  const status = response.ok ? "" : ` (HTTP ${response.status})`;
  return {
    code: "SHEET_NOT_PUBLISHED",
    message: `The sheet URL returned a web page instead of CSV${status}, which means the sheet is not published. Publish it with ${PUBLISH_STEPS}, then copy the resulting URL into SHEET_CSV_URL.`,
  };
}
