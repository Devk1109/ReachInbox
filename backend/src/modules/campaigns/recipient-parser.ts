import { parse } from "csv-parse/sync";

export const MAX_RECIPIENTS_PER_CAMPAIGN = 10_000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_HEADER_NAMES = new Set(["email", "recipient", "email address", "recipient email"]);

export interface InvalidRecipient {
  row: number;
  value: string;
  reason: "MISSING_EMAIL" | "INVALID_FORMAT";
}

export interface RecipientParseResult {
  recipients: string[];
  invalidRecipients: InvalidRecipient[];
  duplicates: string[];
  totalRows: number;
}

export class RecipientFileError extends Error {}

export function parseRecipientCsv(contents: string): RecipientParseResult {
  if (Buffer.byteLength(contents, "utf8") > MAX_UPLOAD_BYTES) {
    throw new RecipientFileError("Recipient file exceeds the 2 MB limit");
  }
  if (contents.split(/\r\n|\r|\n/).length > MAX_RECIPIENTS_PER_CAMPAIGN + 2) {
    throw new RecipientFileError(`A campaign can contain at most ${MAX_RECIPIENTS_PER_CAMPAIGN} recipients`);
  }

  let rows: string[][];
  try {
    rows = parse(contents, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 4096,
    }) as string[][];
  } catch {
    throw new RecipientFileError("Recipient file is not valid CSV");
  }

  const firstRow = rows[0] ?? [];
  const emailColumn = firstRow.findIndex((cell) => EMAIL_HEADER_NAMES.has(cell.trim().toLowerCase()));
  const hasHeader = emailColumn >= 0;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length > MAX_RECIPIENTS_PER_CAMPAIGN) {
    throw new RecipientFileError(`A campaign can contain at most ${MAX_RECIPIENTS_PER_CAMPAIGN} recipients`);
  }
  const recipients: string[] = [];
  const invalidRecipients: InvalidRecipient[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  dataRows.forEach((row, index) => {
    const value = (row[hasHeader ? emailColumn : 0] ?? "").trim();
    const rowNumber = index + (hasHeader ? 2 : 1);
    if (!value) {
      invalidRecipients.push({ row: rowNumber, value, reason: "MISSING_EMAIL" });
      return;
    }
    const normalized = value.toLowerCase();
    if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
      invalidRecipients.push({ row: rowNumber, value, reason: "INVALID_FORMAT" });
      return;
    }
    if (seen.has(normalized)) {
      duplicates.push(normalized);
      return;
    }
    seen.add(normalized);
    recipients.push(normalized);
  });

  return { recipients, invalidRecipients, duplicates, totalRows: dataRows.length };
}
