import { z } from 'zod';
export const recordKindSchema = z.enum(['agents', 'campaigns', 'leads', 'calls']);
export type RecordKind = z.infer<typeof recordKindSchema>;
export const recordSearchInputSchema = z.object({ kind: recordKindSchema, query: z.string().trim().min(1).max(160), after: z.string().uuid().optional() });
export const recordMatchSchema = z.object({ ref: z.string(), id: z.string().uuid(), kind: recordKindSchema, label: z.string(), description: z.string() });
export const recordSearchResultSchema = z.object({ matches: z.array(recordMatchSchema).max(20), next: z.object({ ref: z.string(), after: z.string().uuid() }).nullable() });
export type RecordSearchInput = z.infer<typeof recordSearchInputSchema>;
export type RecordSearchResult = z.infer<typeof recordSearchResultSchema>;
export type PublicRecordResult = { matches: Array<Omit<RecordSearchResult['matches'][number], 'id'>>; continuation: string | null };
export function publicRecordResult(result: unknown): PublicRecordResult | null {
  const parsed = recordSearchResultSchema.safeParse(result);
  if (!parsed.success) return null;
  return { matches: parsed.data.matches.map(({ ref, kind, label, description }) => ({ ref, kind, label, description })), continuation: parsed.data.next?.ref ?? null };
}
