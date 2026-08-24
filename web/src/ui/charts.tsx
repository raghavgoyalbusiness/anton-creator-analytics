import type { ReactNode } from 'react';

/**
 * Charts for the brand report.
 *
 * Built as plain HTML/CSS rather than SVG or a charting library: every form
 * here is a proportional bar, which a div with a width percentage draws more
 * accessibly than an SVG rect — it reflows, it scales with text zoom, and the
 * value can be a real text node rather than a <text> element.
 *
 * Mark specs follow the data-viz method: 4px rounded data-ends anchored to the
 * baseline, a 2px surface gap between adjacent fills, recessive gridlines, and
 * selective direct labels rather than a number on every mark.
 *
 * Identity is never colour-alone. Every bar carries a text label beside it, so
 * the charts remain readable in greyscale, under forced-colors, and printed.
 */

/* ------------------------------------------------------- comparison bars */

export interface ComparisonRow {
  readonly label: string;
  readonly value: number;
  readonly display: string;
  /** The campaign's own bar. Ground bars render neutral. */
  readonly isFigure: boolean;
  readonly caption?: string;
}

/**
 * The headline comparison: this campaign against the operator-supplied
 * benchmark. Two bars, figure and ground.
 *
 * Lower is better here — it is a cost — so the visual argument is that the
 * short bar wins. That inversion is stated in the caption rather than left for
 * the reader to infer from a chart where small looks like less.
 */
export function ComparisonBars({
  rows,
  caption,
}: {
  rows: readonly ComparisonRow[];
  caption?: string;
}): ReactNode {
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <figure className="m-0">
      <div className="space-y-4">
        {rows.map((row) => {
          const pct = Math.max((row.value / max) * 100, 1.5);
          return (
            <div key={row.label}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <span className={`text-label ${row.isFigure ? 'font-semibold' : 'text-ink-secondary'}`}>
                  {row.label}
                </span>
                <span
                  className={`tnum text-heading font-semibold ${
                    row.isFigure ? 'text-accent-ink' : 'text-ink-secondary'
                  }`}
                >
                  {row.display}
                </span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-viz-grid">
                <div
                  className="h-full rounded-full transition-[width] duration-[--duration-slow] ease-[--ease-out]"
                  style={{
                    width: `${pct}%`,
                    background: row.isFigure ? 'var(--color-viz-primary)' : 'var(--color-viz-neutral)',
                  }}
                />
              </div>
              {row.caption ? (
                <p className="mt-1 text-caption text-muted">{row.caption}</p>
              ) : null}
            </div>
          );
        })}
      </div>
      {caption ? (
        <figcaption className="mt-4 text-caption text-muted">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/* ------------------------------------------------------------- bar series */

export interface BarRow {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly display: string;
  readonly meta?: string;
}

/**
 * A single-series horizontal bar list — the breakdowns by creative angle,
 * format and niche.
 *
 * Horizontal rather than vertical because the categories are words of varying
 * length: a vertical bar chart would either truncate them or rotate them 45
 * degrees, and rotated axis labels are the most common unforced error in
 * category charts.
 *
 * A null value renders as "not measured" with no bar at all, rather than a
 * zero-width bar that would read as a real measurement of nothing.
 */
export function BarSeries({
  rows,
  unit,
  emptyLabel = 'Nothing recorded.',
}: {
  rows: readonly BarRow[];
  unit?: string;
  emptyLabel?: string;
}): ReactNode {
  if (rows.length === 0) {
    return <p className="text-label text-muted">{emptyLabel}</p>;
  }

  const max = Math.max(...rows.map((r) => r.value ?? 0), 0.0001);

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => {
        const pct = row.value === null ? 0 : Math.max((row.value / max) * 100, 1.5);
        return (
          <li key={row.key}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="truncate text-label capitalize">{row.label}</span>
              <span className="tnum shrink-0 text-label text-ink-secondary">
                {row.display}
                {row.meta ? <span className="ml-1.5 text-caption text-muted">{row.meta}</span> : null}
              </span>
            </div>
            {row.value === null ? (
              <div className="h-2 w-full rounded-full border border-dashed border-line" />
            ) : (
              <div className="h-2 w-full overflow-hidden rounded-full bg-viz-grid">
                <div
                  className="h-full rounded-full bg-viz-primary transition-[width] duration-[--duration-slow] ease-[--ease-out]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </li>
        );
      })}
      {unit ? <li className="pt-1 text-caption text-muted">{unit}</li> : null}
    </ul>
  );
}

/* -------------------------------------------------------------- coverage */

/**
 * A proportion bar showing how much of the data made it into the report.
 *
 * Segments carry a 2px surface gap so adjacent fills never blend into one
 * another, and every segment is named in the legend beneath — the report must
 * be as clear about what it excluded as about what it counted.
 */
export function CoverageBar({
  segments,
}: {
  segments: readonly { key: string; label: string; count: number; tone: 'figure' | 'warn' | 'ground' }[];
}): ReactNode {
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return null;

  const fill: Record<string, string> = {
    figure: 'var(--color-viz-primary)',
    warn: 'var(--color-warn)',
    ground: 'var(--color-viz-neutral)',
  };

  const present = segments.filter((s) => s.count > 0);

  return (
    <div>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
        {present.map((s) => (
          <div
            key={s.key}
            style={{ width: `${(s.count / total) * 100}%`, background: fill[s.tone] }}
            className="first:rounded-l-full last:rounded-r-full"
          />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {present.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-caption text-muted">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: fill[s.tone] }}
              aria-hidden="true"
            />
            <span className="tnum font-medium text-ink-secondary">{s.count}</span>
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------- inline bar */

/** A bar inside a table cell. Purely supporting — the number carries the value. */
export function InlineBar({ fraction }: { fraction: number }): ReactNode {
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-viz-grid" aria-hidden="true">
      <span
        className="block h-full rounded-full bg-viz-primary"
        style={{ width: `${Math.max(Math.min(fraction, 1) * 100, 1)}%` }}
      />
    </span>
  );
}

/* ----------------------------------------------------------- confidence */

/**
 * Per-field extraction confidence in the operator queue.
 *
 * A meter rather than a number alone: an operator scanning eleven rows spots a
 * short bar faster than they read a percentage, and the percentage stays beside
 * it for when the exact value matters.
 */
export function ConfidenceMeter({ value }: { value: number | null }): ReactNode {
  if (value === null) {
    return <span className="text-caption text-muted">—</span>;
  }
  const low = value < 0.85;
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-viz-grid" aria-hidden="true">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.max(value * 100, 2)}%`,
            background: low ? 'var(--color-warn)' : 'var(--color-viz-primary)',
          }}
        />
      </span>
      <span className={`tnum text-caption ${low ? 'font-medium text-warn' : 'text-muted'}`}>
        {(value * 100).toFixed(0)}%
      </span>
    </span>
  );
}
