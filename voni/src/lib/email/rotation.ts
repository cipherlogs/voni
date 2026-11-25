/**
 * The rotation setting: the one place the page-level mode is stored, and the
 * one rule for what a producer should use.
 *
 * The mode used to live only inside Grafana's saved k6 script, so only Grafana
 * could read it. Now it is one row in `email_settings`, and the script carries
 * a copy that the rebuild overwrites. Two questions, one module, so no producer
 * can grow its own answer:
 *
 *   - "what does the stored setting say?" — `readRotationSetting`, `null`
 *     meaning nobody has chosen yet;
 *   - "what mode should a producer run with right now?" — `currentRotation`,
 *     which is the setting, or the saved script's own mode until the first
 *     write. That second step is the migration path, not a second source of
 *     truth: it disappears the moment the operator saves a mode.
 *
 * Only the setting's own row is owned here. The script's marker is read by the
 * caller (Grafana's API), and arrives as a function, so this module stays a
 * database boundary and every caller stays testable without Postgres.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailSettings } from "@/lib/db/schema";
import {
  isTargetSelection,
  resolveTargetSelection,
  type TargetSelection,
} from "./target-selection";

/** The settings row's key. One console, one row. */
export const EMAIL_SETTINGS_ID = "default";

/**
 * The stored mode, or `null` when it was never written.
 *
 * A value that is not one of the two mode names is also `null`: the column is
 * text, and a hand-edited row must read as "no choice yet" rather than become a
 * mode nothing understands.
 */
export async function readRotationSetting(
  settingsId: string = EMAIL_SETTINGS_ID,
): Promise<TargetSelection | null> {
  const [row] = await db
    .select({ targetSelection: emailSettings.targetSelection })
    .from(emailSettings)
    .where(eq(emailSettings.id, settingsId))
    .limit(1);

  return isTargetSelection(row?.targetSelection) ? row.targetSelection : null;
}

/**
 * Write the operator's choice. The first save creates the row, so a fresh
 * database needs no seed: absence is "nobody chose yet", which is a state the
 * readers already handle.
 */
export async function saveRotationSetting(
  selection: TargetSelection,
  settingsId: string = EMAIL_SETTINGS_ID,
): Promise<void> {
  const now = new Date();
  await db
    .insert(emailSettings)
    .values({ id: settingsId, targetSelection: selection, updatedAt: now })
    .onConflictDoUpdate({
      target: emailSettings.id,
      set: { targetSelection: selection, updatedAt: now },
    });
}

/**
 * The mode every producer must use right now.
 *
 * `readStoredScript` is the saved Grafana script's own marker (or `null` when
 * it carries none or cannot be read). It is consulted only while the setting is
 * unset — once the operator has chosen, a stale copy in the script can never
 * override that choice. `readSetting` is injectable so the migration rule can
 * be proved without a database.
 */
export async function currentRotation(
  readStoredScript: () => Promise<TargetSelection | null>,
  readSetting: () => Promise<TargetSelection | null> = readRotationSetting,
): Promise<TargetSelection> {
  const setting = await readSetting();
  if (setting !== null) return setting;
  return resolveTargetSelection(null, await readStoredScript());
}
