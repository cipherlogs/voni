/**
 * Revalidation from outside a request (queue consumers, scheduled sweeps).
 *
 * `revalidatePath` throws when there is no static-generation store, which is
 * always the case in a queue/scheduled handler. Dashboard pages read fresh
 * data through polling anyway, so a failed revalidation is a non-event —
 * never let it fail a job.
 */
export function safeRevalidatePath(path: string): void {
  import("next/cache")
    .then(({ revalidatePath }) => revalidatePath(path))
    .catch(() => undefined);
}
