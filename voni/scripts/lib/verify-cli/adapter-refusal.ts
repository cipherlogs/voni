/**
 * The one place the CLI turns an adapter's result into the refusal it prints.
 *
 * Both adapters write their own named refusal (`result.refusal`) beside an
 * `unrun` list that carries INFO as well as the cause. Reporting `unrun[0]`
 * instead showed the operator the wrong reason — a live run refused for a
 * missing pipeline was printed as "the budget is unknown", which names a gap,
 * not the cause. The adapter's refusal wins; `unrun` is only a fallback for an
 * adapter that produced no named cause.
 */

export type AdapterRefusal = {
  readonly code: string;
  readonly message: string;
};

export function adapterRefusalFor(input: {
  /** True when the adapter exited 2 / reported `refused`. */
  readonly refused: boolean;
  /** The adapter's own named refusal, when it recorded one. */
  readonly refusal: AdapterRefusal | null;
  /** The adapter's INFO/cause list, used only when no refusal was recorded. */
  readonly unrun: readonly string[];
  /** What to say when neither is available. */
  readonly fallback: string;
}): AdapterRefusal | null {
  if (!input.refused) return null;
  if (input.refusal !== null) return input.refusal;
  return {
    code: "adapter-refused",
    message: input.unrun[0] ?? input.fallback,
  };
}
