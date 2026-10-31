#!/usr/bin/env node
/**
 * Check or move the contract bar record.
 *
 * The record pins the number each numeric property bar resolves to and the
 * digest of each frozen threshold record. A threshold edit changes the live
 * resolution, so this check fails until the record is moved — deliberately,
 * after a reviewed spec change. Never hand-edit the JSON.
 *
 *   npm run contract:bars            # check (exit 1 on drift)
 *   npm run contract:bars -- --write # move the record
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  CONTRACT_BARS_PATH,
  buildContractBarRecord,
  loadContract,
  loadThresholdTables,
} from "../src/lib/demo/verification/contract/index";

const write = process.argv.includes("--write");
const contract = await loadContract();
const record = buildContractBarRecord(contract, loadThresholdTables());
const text = `${JSON.stringify(record, null, 2)}\n`;

if (write) {
  writeFileSync(CONTRACT_BARS_PATH, text);
  console.log(
    `contract-bars: wrote ${Object.keys(record.properties).length} properties to ${CONTRACT_BARS_PATH.pathname}`,
  );
} else {
  let current = "";
  try {
    current = readFileSync(CONTRACT_BARS_PATH, "utf8");
  } catch {
    console.error("contract-bars: no committed record; run `npm run contract:bars -- --write`");
    process.exit(1);
  }
  if (current !== text) {
    console.error(
      "contract-bars: the committed record does not match the frozen thresholds; " +
        "a threshold edit must move the record (`npm run contract:bars -- --write`) " +
        "and be reviewed as a spec change",
    );
    process.exit(1);
  }
  console.log(`contract-bars: ${Object.keys(record.properties).length} properties match the frozen records`);
}
