/**
 * Pure gating rule for the photo-book builder's 3-step wizard (upload → create → order,
 * `photo-book-builder.tsx`). Extracted out of `goToStep` so the two rules — "analysis
 * must be done before leaving step 1" and "the book must have been generated at least
 * once before reaching step 3 (order)" — are unit-testable without a component harness.
 *
 * Deliberately free of any `db`/`env` import so it can be imported by value into client
 * components (same rationale as `lib/book-print-status.ts`).
 *
 * `generatedAt` is `books.generated_at` (stamped only by the explicit "Create book"/
 * "Design again" job, `PhotoBookCreateStep`'s Step 2 gate) — reaching step 3 (order)
 * without it would let "Download PDF" silently build the plain auto-layout, bypassing
 * the whole configure→generate flow.
 */
export function canAccessPhotoBookStep(
  index: number,
  analysisComplete: boolean,
  generatedAt: string | Date | null,
): boolean {
  if (index >= 1 && !analysisComplete) return false;
  if (index >= 2 && generatedAt == null) return false;
  return true;
}
