import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhoneE164, parseCsv, parseLeadCsv } from "./csv";

test("parses quoted fields containing commas, quotes, and newlines", () => {
  const rows = parseCsv(
    'name,notes\n"Al Habtoor, Sara","She said ""call after 4"".\nTwo bedrooms."\n',
  );
  assert.deepEqual(rows, [
    ["name", "notes"],
    ["Al Habtoor, Sara", 'She said "call after 4".\nTwo bedrooms.'],
  ]);
});

test("handles CRLF, a bare CR, a BOM, and a missing trailing newline", () => {
  const rows = parseCsv("﻿a,b\r\n1,2\r3,4");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("a trailing newline does not produce a phantom empty row", () => {
  assert.equal(parseCsv("phone\n+971501234567\n").length, 2);
  // ...but a genuinely empty trailing field is still a field.
  assert.deepEqual(parseCsv("a,b\n1,").at(-1), ["1", ""]);
});

test("normalizes the national formats a human-typed CSV actually contains", () => {
  const cases: [string, string | null][] = [
    ["+971 50 123 4567", "+971501234567"],
    ["050 123 4567", "+971501234567"], // trunk prefix stripped, country code added
    ["00971501234567", "+971501234567"], // international prefix
    ["971501234567", "+971501234567"], // already country-coded, no plus
    ["501234567", "+971501234567"], // bare national number
    ["(04) 123-4567", "+97141234567"],
    ["+971 4 123 4567 ext. 22", "+97141234567"], // extension is not dialable
    ["+44 7512 345678", "+447512345678"], // a non-default country survives
    ["12345", null], // too short to route
    ["not a phone", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizePhoneE164(input, "971"), expected, `input ${JSON.stringify(input)}`);
  }
});

test("imports a realistic export, mapping aliased headers", () => {
  const result = parseLeadCsv(
    [
      "Full Name,Mobile Number,Lead Source,Opt-In,Requirements",
      "Sara Al Habtoor,050 123 4567,Property Finder,yes,2BR Marina",
      "Omar Haddad,+971 55 987 6543,Bayut,no,Villa Saadiyat",
      "Lina Farah,0529998888,Website,,Studio",
    ].join("\n"),
  );

  assert.equal(result.errors.length, 0);
  assert.deepEqual(
    result.leads.map((l) => l.phone),
    ["+971501234567", "+971559876543", "+971529998888"],
  );
  assert.deepEqual(
    result.leads.map((l) => l.consentStatus),
    ["granted", "revoked", "unknown"],
  );
  assert.equal(result.leads[0].name, "Sara Al Habtoor");
  assert.equal(result.leads[0].source, "Property Finder");
  assert.equal(result.leads[2].notes, "Studio");
});

test("every rejected row is reported with its spreadsheet line number", () => {
  const result = parseLeadCsv(
    ["name,phone", "Good,+971501234567", "Bad,banana", "NoPhone,"].join("\n"),
  );
  assert.equal(result.leads.length, 1);
  assert.deepEqual(
    result.errors.map((e) => e.line),
    [3, 4],
  );
  assert.match(result.errors[0].message, /not a usable phone number/);
  assert.match(result.errors[1].message, /Missing phone number/);
});

test("in-file duplicates are counted, not imported twice", () => {
  const result = parseLeadCsv(
    // The same person written three ways: all normalize to one number.
    ["phone", "+971501234567", "050 123 4567", "00971501234567"].join("\n"),
  );
  assert.equal(result.leads.length, 1);
  assert.equal(result.duplicates, 2);
});

test("a file with no phone column is rejected with actionable guidance", () => {
  const result = parseLeadCsv("name,email\nSara,sara@example.com");
  assert.equal(result.leads.length, 0);
  assert.match(result.errors[0].message, /No phone column/);
});

test("an empty file is an error, not a silent zero-row import", () => {
  assert.equal(parseLeadCsv("").errors.length, 1);
});
