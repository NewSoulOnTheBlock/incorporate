---
name: Incorporate
description: A company registry where every shareholder is on the payroll
colors:
  paper: "#FBFAF7"
  paper-sunk: "#F2F0EA"
  card: "#FFFFFF"
  ink: "#14161A"
  ink-soft: "#5B6068"
  ink-faint: "#8B9098"
  rule: "#E2DDD2"
  rule-hard: "#C9C2B4"
  accent: "#0B5D3B"
  accent-ink: "#FFFFFF"
  up: "#0B5D3B"
  down: "#9B2226"
  flag: "#B45309"
  dark-paper: "#0E1116"
  dark-paper-sunk: "#0A0D11"
  dark-card: "#151A21"
  dark-ink: "#E8E6E1"
  dark-ink-soft: "#9BA3AD"
  dark-ink-faint: "#6B7280"
  dark-rule: "#232830"
  dark-rule-hard: "#333A45"
  dark-accent: "#4ADE80"
  dark-accent-ink: "#06210F"
  dark-down: "#F87171"
  dark-flag: "#FBBF24"
typography:
  display:
    fontFamily: "Newsreader, Georgia, Times New Roman, serif"
    fontSize: "clamp(38px, 6vw, 62px)"
    fontWeight: 500
    lineHeight: 1.04
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "27px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  body:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.13em"
rounded:
  sm: "3px"
  md: "4px"
spacing:
  xs: "6px"
  sm: "11px"
  md: "14px"
  lg: "22px"
  xl: "44px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 15px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 15px"
  wallet-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "7px 13px"
    typography: "{typography.data}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "22px"
  pill:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
    typography: "{typography.label}"
  table-header:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink-faint}"
    padding: "11px 14px"
    typography: "{typography.label}"
  stat-tile:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "18px 20px 20px"
---

## Overview

The visual language is a **company registry**: filing paper, ruled ledgers, and
monospace figures. It borrows from statutory registers and filing documents
rather than from fintech dashboards — warm paper rather than cold white, hairline
rules rather than cards floating on shadow, and a single sober registry green
that reads as an official stamp rather than a brand colour.

The governing instinct: this is a **record**, and a record's authority comes from
being legible and consistent, not from being decorated. Figures are set so they
can be read down a column. Structure is drawn with lines, not with depth.

Note the product direction has shifted toward framing Incorporate as a game
rather than a financial instrument. The world documented here is the incumbent
one and does not yet reflect that; treat it as evidence of where the surface
currently stands, not as a mandate to keep it if a replacement world is chosen.

## Colors

Two complete palettes, light and dark, expressed as CSS custom properties on
`:root`. Light is the base definition; dark is redefined in both
`@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`
and again under `:root[data-theme="dark"]`, so an explicit toggle wins in either
direction.

- **paper / paper-sunk / card** — the three ground planes. `paper` is the page,
  `paper-sunk` is a recessed area (table headers, code blocks, callouts), `card`
  is a raised surface. Light mode's paper is deliberately warm (`#FBFAF7`), not
  white; white is reserved for `card` so raised surfaces read as sheets laid on
  a desk.
- **ink / ink-soft / ink-faint** — a three-step text ramp. Body copy sits at
  `ink-soft`, not `ink`; `ink` is reserved for headings and emphasis so that
  bolding something actually changes it.
- **rule / rule-hard** — hairlines. `rule` divides; `rule-hard` bounds an
  interactive control.
- **accent** — registry green, `#0B5D3B` light / `#4ADE80` dark. Used for the
  brand full stop, primary buttons, active states, and the "public" status.
  Deployed sparingly; it is a stamp, not a theme.
- **up / down / flag** — semantic only. `down` for failure and off-payroll,
  `flag` amber for warnings and private-round status.

## Typography

Three families, each with one job, and the split is load-bearing:

- **Newsreader (serif)** — display and section headings only. Supplies the
  document character.
- **IBM Plex Mono** — every figure, ticker, address, label and eyebrow. All
  numeric cells carry `font-variant-numeric: tabular-nums`.
- **System sans** — body copy and controls.

Labels and eyebrows are mono, 10–11px, uppercase, `letter-spacing: 0.13em`, in
`ink-faint`. This treatment marks anything that names data rather than being
data.

Prose is capped at `70ch`. Hero copy at `62ch`. Display headings cap at `17ch`
so they break into deliberate lines.

## Layout

- Page container `max-width: 1140px` with 24px gutters.
- Documentation uses a two-column grid, `220px` sticky table of contents plus
  `1fr` prose, 48px gap, collapsing to a single column at 860px.
- Stat rows and card grids use `repeat(auto-fit, minmax(…, 1fr))` so they reflow
  without breakpoints.
- Tables have `min-width: 720px` inside an `overflow-x: auto` wrapper. Wide data
  scrolls within its own container; the page body never scrolls horizontally.
- Section rhythm: 44px above a section head, 14px below it.

## Elevation & Depth

**Structure is drawn with lines, not shadows.** Every surface boundary is a 1px
`rule` border. A `--shadow` token exists but is deliberately almost unused — the
registry reads as printed matter, and printed matter does not cast shadows.

Sticky elements (masthead, docs table of contents) hold position without gaining
elevation; the masthead is separated by a single bottom rule.

## Shapes

Radii are small and few: `3px` for controls (buttons, pills, inputs) and `4px`
for containers (cards, tables, callouts). Nothing is pill-shaped or circular
except the loading spinner. Squareness is part of the document character.

Callouts use an asymmetric radius (`0 4px 4px 0`) with a 3px left border in
`accent`, or `flag` for warnings — the visual equivalent of a margin rule.

## Components

- **Masthead** — sticky, 62px, brand wordmark with an accent full stop, nav in
  uppercase mono-adjacent sans, wallet button right-aligned.
- **Stat row** — a horizontal band of label-over-figure tiles divided by vertical
  rules, no borders top or bottom beyond the band itself.
- **Register table** — mono tickers, sans company names, right-aligned numeric
  columns, status as a pill. Rows are hoverable and clickable.
- **Pill** — status marker. `public` (accent), `private` (flag), `off` (down),
  default neutral.
- **Card** — bordered container for prose blocks and form panels.
- **Callout** — left-ruled note block; the `warn` variant carries the amber rule
  and is used for mechanics that disadvantage the reader.
- **Formula** — centred mono block on `paper-sunk`, used for the payroll weight
  and payout expressions.
- **Steps** — segmented horizontal progress strip for the filing flow.
- **Status box** — left-ruled feedback panel with `work` / `ok` / `bad` variants,
  carrying a spinner during async work.

## Do's and Don'ts

**Do**

- Set every figure in mono with tabular numerals so columns align when read down.
- Use `ink-soft` for body copy and reserve `ink` for hierarchy.
- Draw boundaries with hairline rules.
- Define every colour on bare `:root` first, then redefine only the changed
  tokens for dark. Give `body` an explicit token background.
- State a disadvantaging mechanic in a `warn` callout rather than burying it.
- Let wide tables scroll inside their own container.

**Don't**

- Don't set money, addresses, tickers, or percentages in a proportional face.
- Don't reach for shadows to create hierarchy; use rules, ground planes, and
  spacing.
- Don't spread the accent green across large areas — it is a stamp.
- Don't use `up` / `down` / `flag` decoratively; they carry meaning.
- Don't invent figures. Real data comes from the Registrar; illustrative data
  must stay visibly labelled as a sample.
- Don't round corners beyond 4px or introduce pill-shaped controls.
