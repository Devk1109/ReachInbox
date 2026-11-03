import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_RECIPIENTS_PER_CAMPAIGN, parseRecipientCsv, RecipientFileError } from "./recipient-parser";

test("recipient parser handles BOM, headers, whitespace, and case-insensitive duplicates", () => {
  const result = parseRecipientCsv("\uFEFFName,Email\r\nAda, ADA@example.com \r\nBob,bob@example.com\r\nAda,ada@EXAMPLE.com");

  assert.deepEqual(result.recipients, ["ada@example.com", "bob@example.com"]);
  assert.deepEqual(result.duplicates, ["ada@example.com"]);
  assert.deepEqual(result.invalidRecipients, []);
  assert.equal(result.totalRows, 3);
});

test("recipient parser reports missing and malformed addresses with source row numbers", () => {
  const result = parseRecipientCsv("recipient,other\n,blank-value\nnot-an-email,malformed-value");

  assert.deepEqual(result.invalidRecipients, [
    { row: 2, value: "", reason: "MISSING_EMAIL" },
    { row: 3, value: "not-an-email", reason: "INVALID_FORMAT" },
  ]);
  assert.deepEqual(result.recipients, []);
});

test("recipient parser reads line-delimited text without a header", () => {
  const result = parseRecipientCsv("first@example.com\nsecond@example.com\n");
  assert.deepEqual(result.recipients, ["first@example.com", "second@example.com"]);
});

test("recipient parser rejects oversized uploads and malformed CSV", () => {
  assert.throws(() => parseRecipientCsv("x".repeat(2 * 1024 * 1024 + 1)), RecipientFileError);
  assert.throws(() => parseRecipientCsv('"unterminated@example.com'), RecipientFileError);
});

test("recipient parser enforces the maximum recipient count with and without a header", () => {
  const recipients = Array.from({ length: MAX_RECIPIENTS_PER_CAMPAIGN + 1 }, (_, index) => `person${index}@example.com`);
  assert.throws(() => parseRecipientCsv(recipients.join("\n")), RecipientFileError);
  assert.throws(() => parseRecipientCsv(["email", ...recipients].join("\n")), RecipientFileError);
});
