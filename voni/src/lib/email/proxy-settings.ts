/**
 * The database boundary for the proxy card: one row, two columns.
 *
 * The rules live in `proxy-policy.ts`; this module only reads and writes them.
 * One writer means the country and the target cannot be updated by different
 * code paths: a save always writes US, because no other country can reach the
 * write, and the target it writes is the one the action already validated.
 *
 * The row is the console's existing `email_settings` row, not a producer's row.
 * The exit layer belongs to the page — the same pool serves every click the
 * GitHub Source sends — so it is read once and used by whichever client start
 * or dispatch asks for it next.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailSettings } from "@/lib/db/schema";
import { EMAIL_SETTINGS_ID } from "./rotation";
import {
  PROXY_COUNTRY,
  resolveProxySettings,
  type ProxySettings,
} from "./proxy-policy";

/**
 * What the client should use, already resolved.
 *
 * A missing row, a `null` target and an out-of-range hand edit all read as the
 * default. The stored country is deliberately not read back: US is the client's
 * constraint, and a row that says otherwise must not become a value the page
 * passes down.
 */
export async function readProxySettings(
  settingsId: string = EMAIL_SETTINGS_ID,
): Promise<ProxySettings> {
  const [row] = await db
    .select({
      proxyCountry: emailSettings.proxyCountry,
      proxyPoolTarget: emailSettings.proxyPoolTarget,
    })
    .from(emailSettings)
    .where(eq(emailSettings.id, settingsId))
    .limit(1);

  return resolveProxySettings(row);
}

/**
 * Write the operator's choice. The first save creates the row, and the country
 * column is written from the constant rather than from the caller, so a bug in
 * the action cannot store another country.
 */
export async function writeProxySettings(
  settings: Pick<ProxySettings, "country" | "poolTarget">,
  settingsId: string = EMAIL_SETTINGS_ID,
): Promise<void> {
  const now = new Date();
  await db
    .insert(emailSettings)
    .values({
      id: settingsId,
      proxyCountry: PROXY_COUNTRY,
      proxyPoolTarget: settings.poolTarget,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: emailSettings.id,
      set: {
        proxyCountry: PROXY_COUNTRY,
        proxyPoolTarget: settings.poolTarget,
        updatedAt: now,
      },
    });
}
