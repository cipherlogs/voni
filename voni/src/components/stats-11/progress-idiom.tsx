/**
 * Vendored from Blocks (MIT ©2025 Ephraim Duncan) — registry item
 * `@blocks-so/stats-11` (https://blocks.so/r/stats-11.json).
 * See voni/THIRD-PARTY-NOTICES.md. Pinned per voni/DESIGN.md §3.
 * Adaptations for this project: ONLY the MetricCard thin progress-bar
 * idiom is vendored (relative h-1 overflow-hidden rounded-full bg-muted
 * track + origin-left fill scaled via inline style percent/100 — this
 * single style={{ transform }} is the DESIGN.md-blessed re-homed
 * exception). BudgetDialog NOT vendored (no budget feature; label
 * primitive stays uninstalled). Upstream hardcoded hue fills
 * + warning text replaced with semantic tokens (fill defaults to
 * bg-primary, overridable via fillClassName). dark-mode duplicates stripped.
 * No lucide / card / dialog / input imports — progress markup only.
 */

import { cn } from '@/lib/utils';

interface ProgressIdiomProps {
  /** Fill percent, 0–100. Values above 100 are clamped. */
  percentage: number;
  /** Token fill class for the bar. Defaults to bg-primary. */
  fillClassName?: string;
  className?: string;
}

export default function ProgressIdiom({
  percentage,
  fillClassName = 'bg-primary',
  className,
}: ProgressIdiomProps) {
  return (
    <div
      className={cn(
        'relative h-1 w-full overflow-hidden rounded-full bg-muted',
        className,
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(Math.max(percentage, 0), 100)}
    >
      <div
        className={cn(
          'h-full w-full origin-left transition-transform duration-200 ease-out',
          fillClassName,
        )}
        style={{ transform: `scaleX(${Math.min(percentage, 100) / 100})` }}
      />
    </div>
  );
}
