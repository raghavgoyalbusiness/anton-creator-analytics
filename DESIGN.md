# Anton design system

The visual language behind the three surfaces. Written down because a system
nobody can look up gets reinvented per screen.

## Colour

Every colour was validated with a palette validator against the actual page
surfaces rather than chosen by eye.

| Role | Light | Dark | Why |
| --- | --- | --- | --- |
| `accent` | `#00794d` | `#4fc79a` | Chroma ≥ 0.1, contrast ≥ 3:1 on both surfaces |
| `viz-primary` | `#00794d` | `#4fc79a` | The campaign's own data |
| `viz-neutral` | `#a8a59b` | `#87857c` | Deliberately low-chroma — the benchmark is *ground*, not a competing brand colour |

The chart pair clears CVD ΔE 10.2 light / 13.2 dark and normal-vision 16.8 / 18.2.

### Status colours cannot be separated by hue alone

Amber and red at equal lightness are indistinguishable to a deuteranope. That is
physics, not a bad hex — the validator returns ΔE 4.3 for the pair whatever
values you try. So:

1. **Every status surface ships an icon and a label.** `Notice` renders a glyph
   and an `sr-only` tone name, so colour is never the only channel.
2. **Warning sits lighter than danger** so lightness carries the distinction
   where hue cannot.

This replaced the original palette, where `#8a5a10` warn and `#9b2c1f` danger
were indistinguishable to a colourblind operator — a real accessibility bug the
validator caught in shipped code.

## Type

A semantic scale, not ad-hoc sizes. Before this, the app used 78 `text-sm` and
40 `text-xs` with no meaning attached to either.

| Token | Size | Used for |
| --- | --- | --- |
| `text-display` | 2.75rem | The one number a page is about |
| `text-title` | 1.75rem | Page title |
| `text-figure` | 2rem | Stat tile values |
| `text-heading` | 1.125rem | Section headings |
| `text-body` | 0.9375rem | Prose |
| `text-label` | 0.8125rem | UI labels, table cells |
| `text-caption` | 0.75rem | Footnotes, metadata |

`.tnum` applies tabular figures to every number in a table or tile — a metric
that jitters as digits change is harder to scan and looks careless.

## Components

`Button` (4 variants × 2 sizes, loading state) · `Card` · `Notice` (4 tones, all
with icons) · `Badge` · `Stat` · `Table`/`Tr`/`Td` · `Field` · `Spinner` ·
`EmptyState` · `SectionHeading` · `Icon`

Charts: `ComparisonBars` · `BarSeries` · `CoverageBar` · `InlineBar` ·
`ConfidenceMeter`

## Charts

Plain HTML/CSS, not SVG or a charting library. Every form here is a proportional
bar, which a div with a width percentage draws more accessibly than an SVG rect:
it reflows, it scales with text zoom, and the value is a real text node.

Rules that hold everywhere:

- **Identity is never colour-alone.** Every bar carries a text label, so the
  charts survive greyscale, forced-colors and print.
- **Null is not zero.** A missing value renders a dashed outline and the words
  "not measured", never a zero-width bar that would read as a real measurement.
- **Horizontal bars for word categories.** Vertical bars would force truncation
  or 45° rotated labels, the most common unforced error in category charts.
- **Median, not mean**, in every breakdown — one viral post should not crown a
  category.
- **Lower-is-better is stated, not implied.** The cost comparison says "shorter
  is better" rather than leaving the reader to infer it.

## Motion

`--duration-fast` 120ms for state changes, `--duration-base` 200ms for
transitions, `--duration-slow` 420ms for bars growing on load. All of it is
disabled under `prefers-reduced-motion`.

## Elevation

Two levels only: `--shadow-raised` for cards, `--shadow-overlay` for things
above the page. This is an instrument panel, not a marketing page — depth
separates layers and never decorates.
