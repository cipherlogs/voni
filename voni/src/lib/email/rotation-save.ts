/**
 * Saving the rotation mode: one write, then one rebuild, and two outcomes that
 * are not the same failure.
 *
 * The setting is the source of truth and is written first. The Grafana script is
 * rebuilt from the value just written, so a rebuild that fails leaves the
 * console's choice stored and the next GitHub dispatch already carrying it —
 * only Grafana still runs the previous mode until a retry lands. Reporting that
 * as a total failure ("could not save the rotation mode") would be a lie about
 * the setting, so it is its own state: `ok` with a `warning`.
 *
 * The dependencies are injected because this is a server action's body: a test
 * can drive every branch without Next's request context or Grafana, and the
 * action itself stays the thin part that validates the form and revalidates.
 */
import {
  describeTargetSelection,
  type TargetSelection,
} from "./target-selection";

export type RotationSaveOutcome =
  | { ok: true; message: string; warning?: string }
  | { ok: false; error: string };

export interface RotationSaveDeps {
  /** The one write. Throwing means nothing changed. */
  saveSetting: (selection: TargetSelection) => Promise<void>;
  /** The live check, for the clicks-per-run the rebuilt script must carry. */
  readCheck: () => Promise<
    { ok: true; clicksPerRun: number } | { ok: false; message: string }
  >;
  /** The active target list the rebuilt script must click. */
  readTargets: () => Promise<string[]>;
  /** Upload the rebuilt script; `null` is success, a string is why it failed. */
  rebuild: (input: {
    clicksPerRun: number;
    targets: string[];
    selection: TargetSelection;
  }) => Promise<string | null>;
}

export async function saveRotationMode(
  selection: TargetSelection,
  deps: RotationSaveDeps,
): Promise<RotationSaveOutcome> {
  try {
    await deps.saveSetting(selection);
  } catch {
    return {
      ok: false,
      error:
        "The rotation setting could not be saved, so nothing changed. Try again.",
    };
  }

  // What the operator can already rely on, whatever happens to Grafana next.
  const storedForGithub =
    `The setting is saved, so the next GitHub dispatch will ` +
    `${describeTargetSelection(selection)}.`;

  const current = await deps.readCheck();
  if (!current.ok) {
    return {
      ok: true,
      message: storedForGithub,
      warning:
        `${storedForGithub} Grafana's check could not be read, so its script ` +
        `still runs the previous mode: ${current.message} Save again to retry.`,
    };
  }

  let uploadError: string | null;
  try {
    uploadError = await deps.rebuild({
      clicksPerRun: current.clicksPerRun,
      targets: await deps.readTargets(),
      selection,
    });
  } catch (error) {
    uploadError = error instanceof Error ? error.message : String(error);
  }

  if (uploadError !== null) {
    return {
      ok: true,
      message: storedForGithub,
      warning:
        `${storedForGithub} Grafana's script could not be rebuilt, so it still ` +
        `runs the previous mode: ${uploadError} Save again to retry.`,
    };
  }

  return {
    ok: true,
    message:
      `Saved. Grafana's script and every GitHub dispatch now ` +
      `${describeTargetSelection(selection)}.`,
  };
}
