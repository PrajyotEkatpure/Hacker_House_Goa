# Brand assets (PLACEHOLDERS)

Everything in this folder is a hand-drawn stand-in in the "retro Goan matchbox" style.
**None of it is official Hacker House Goa artwork.** Swap it before anything ships publicly.

| File | Used for | viewBox |
| --- | --- | --- |
| `logo.svg` | Header / footer lockup badge | 240 x 64 |
| `sun.svg` | Decorative half-sun in the page chrome | 64 x 64 |
| `palm.svg` | Decorative palm silhouette | 64 x 96 |
| `wave.svg` | Horizontally tiling wave rule / divider | 240 x 24 |

The 1080x1080 PFP frame and the 1080x1350 Builder ID card are composited procedurally on
`<canvas>` in `lib/render.ts`; these files are **decorative only** and never required. Per the
contract in `lib/brand.ts`, a compositor may load a `BRAND_ASSETS` entry as an enhancement, but
every one of them is optional at runtime — a missing or unparseable file must fall back to the
procedurally drawn glyph, never fail the export.

## Replacing them with the official Brand Kit

1. Go to <https://hhgoa.com>, footer -> **Brand Kit**.
2. Download the SVG (not PNG) versions of: the primary horizontal logo lockup, and any sun / palm /
   wave ornaments included in the kit.
3. Drop them into this folder using **exactly these filenames** — `logo.svg`, `sun.svg`, `palm.svg`,
   `wave.svg`. Keeping the names identical makes it a zero-code swap: no imports change.
4. If the official artwork has a different aspect ratio, keep its own `viewBox` and let the
   consuming component size it; only `wave.svg` has a hard requirement (see below).

### Constraints any replacement must satisfy

- Self-contained: no `<image>` rasters, no external font/CSS/URL references. SVGs are inlined or
  served statically, so anything external will silently fail to render.
- No `<style>` blocks that depend on CSS custom properties — use inline `fill` attributes.
- Keep `xmlns`, a `viewBox`, `role="img"` and a `<title>` (accessibility + correct scaling).
- Name the graphic with `aria-label` on the root, **not** `aria-labelledby`. Keep the files free of
  `id` attributes entirely: `logo.svg` is inlined more than once per page, and duplicate ids mean
  every copy resolves its name to the first one.
- Keep the `width` / `height` attributes on the root alongside the `viewBox`. An SVG with no
  intrinsic size cannot be reliably passed to `ctx.drawImage()` — Safari in particular draws
  nothing.
- **All ink must fit inside the `viewBox`.** Anything outside is clipped, and bezier control points
  are not the curve: a control point at y=28 in a 24-high box can still be fine, while one at y=23
  may not be. Check the actual extrema.
- Palette: `#1E4D2B` green, `#FFF3DC` cream, `#E23B22` red, `#F2B705` yellow, `#17130E` ink.
- `wave.svg` must leave the right edge at the same `y` **and the same tangent** as it enters the
  left edge, or the tiled divider shows a kink at every seam. The current file enters and exits at
  y=9 (top) / y=15 (bottom) with tangent (15,-8).
- Text inside an SVG must be outlined to `<path>`. Live `<text>` with a webfont will not render.

## Where to change things

`lib/brand.ts` is the single source of truth for colours, event strings and asset paths:
`COLORS`, `TINTS`, `FONTS`, `EVENT`, `COHORT_SIZE`, `BRAND_ASSETS`. Edit there — do not hardcode a
hex or a `/brand/*.svg` path anywhere else. The Tailwind tokens in `app/globals.css`
(`goa-green`, `goa-cream`, ...) mirror the same palette and should be updated alongside it.
