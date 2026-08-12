/**
 * canvasKit — dumb, reusable 2D primitives for the FrameInGoa compositors.
 *
 * Nothing in here knows about the product layout. `lib/render.ts` owns all
 * coordinates; this file owns "how do you draw a palm / an arc of text / grain
 * that doesn't take 400ms on a phone".
 *
 * Two rules every helper follows:
 *  1. It save()/restore()s anything it mutates, so callers stay idempotent.
 *  2. It works in whatever space the caller has set up (design space here) and
 *     never touches canvas.width/height or DPR.
 */

import { FONT_FALLBACK } from "./brand";
import type { Rect } from "./types";

/* --------------------------------------------------------------------- misc */

const TAU = Math.PI * 2;

/**
 * Canonical `ctx.font` builder. Every text draw in the app goes through this so
 * the family name and fallback chain can never drift from lib/fonts.ts.
 */
export function fontString(
  size: number,
  family: string,
  weight: number | string = 400,
): string {
  return `${weight} ${size}px "${family}", ${FONT_FALLBACK}`;
}

/**
 * mulberry32 — 32-bit seeded PRNG. Deterministic across browsers (pure integer
 * math, no Math.random), which is what makes grain/barcodes reproducible so the
 * preview and the exported PNG are pixel-identical.
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------- shapes */

/**
 * Rounded-rectangle *path only* — the caller decides fill / stroke / clip.
 * Hand-rolled rather than `ctx.roundRect` because that landed in Safari 16 and
 * we still see 15.x on older iPads.
 */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  // A radius bigger than half the short side produces self-intersecting arcs.
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * Donut path: outer circle clockwise + inner circle counter-clockwise. With the
 * default nonzero fill rule the winding numbers cancel inside the hole, so
 * `ctx.clip()` after this yields the ring band only. Used to keep grain off the
 * face on the PFP.
 */
export function annulusPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
): void {
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, TAU, false);
  ctx.arc(cx, cy, innerR, TAU, 0, true);
  ctx.closePath();
}

/* -------------------------------------------------------------------- grain */

/**
 * Grain tiles are expensive to build (one PRNG call per pixel) and free to
 * reuse, so they are memoised by seed+opacity. A 128px tile at 1080px wide
 * repeats ~8.4 times, which is small enough that the eye reads it as noise
 * rather than a pattern.
 */
const GRAIN_TILE = 128;
const grainCache = new Map<string, HTMLCanvasElement>();

function grainTile(seed: number, opacity: number): HTMLCanvasElement | null {
  const key = `${seed >>> 0}:${opacity.toFixed(4)}`;
  const hit = grainCache.get(key);
  if (hit) return hit;

  const tile = document.createElement("canvas");
  tile.width = GRAIN_TILE;
  tile.height = GRAIN_TILE;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;

  const img = tctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  const data = img.data;
  const rng = makeRng(seed);
  for (let i = 0; i < data.length; i += 4) {
    const n = rng();
    // Bipolar grain: half the specks lift the paper, half bruise it. Pure dark
    // noise reads as dirt; mixing both reads as printed halftone.
    const v = n < 0.5 ? 0 : 255;
    // Square the alpha ramp so most pixels are nearly invisible and only a few
    // pop — that uneven distribution is what makes it look like film, not TV static.
    const a = rng();
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = Math.round(a * a * opacity * 255);
  }
  tctx.putImageData(img, 0, 0);
  grainCache.set(key, tile);
  return tile;
}

/**
 * Fill `rect` with deterministic film grain. Clip first if you need it confined
 * to a non-rectangular region (see `annulusPath`).
 */
export function drawGrain(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  opacity: number,
  seed: number,
): void {
  if (opacity <= 0 || rect.w <= 0 || rect.h <= 0) return;
  const tile = grainTile(seed, opacity);
  if (!tile) return;
  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return;
  ctx.save();
  // Pattern space follows the CTM, so translate first and fill from the origin;
  // that keeps tiles phase-locked to the rect instead of to the canvas.
  ctx.translate(rect.x, rect.y);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, rect.w, rect.h);
  ctx.restore();
}

/* ------------------------------------------------------------------ sunburst */

/** Alternating wedge rays radiating from (cx, cy). The classic matchbox device. */
export function drawSunburst(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  rayCount: number,
  colorA: string,
  colorB: string,
  rotation: number,
): void {
  if (rayCount < 2 || radius <= 0) return;
  const step = TAU / rayCount;
  ctx.save();
  for (let i = 0; i < rayCount; i++) {
    const a0 = rotation + i * step;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, a0, a0 + step, false);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? colorA : colorB;
    ctx.fill();
  }
  ctx.restore();
}

/* --------------------------------------------------------------------- sun */

/** Filled disc + radiating spokes. `r` is the outer radius including spokes. */
export function drawSunGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
): void {
  if (r <= 0) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.58, 0, TAU);
  ctx.fill();

  const spokes = 12;
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.lineCap = "butt";
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU + Math.PI / spokes;
    const inner = r * 0.74;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.restore();
}

/* -------------------------------------------------------------------- palm */

/**
 * Procedural coconut palm. (cx, cy) is the base of the trunk, `h` the height
 * from base to crown. Tuned to still read as a palm around 40px tall: few, fat
 * fronds beat many thin ones once the silhouette gets small.
 */
export function drawPalmGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  h: number,
  color: string,
): void {
  if (h <= 0) return;
  ctx.save();
  ctx.fillStyle = color;

  // Crown sits up and slightly to the right; the trunk leans into it.
  const crownX = cx + h * 0.11;
  const crownY = cy - h * 0.74;
  const baseHalf = h * 0.072;
  const tipHalf = h * 0.03;
  const ctrlX = cx - h * 0.07;
  const ctrlY = cy - h * 0.42;

  // Tapered trunk: up the left edge, down the right edge.
  ctx.beginPath();
  ctx.moveTo(cx - baseHalf, cy);
  ctx.quadraticCurveTo(ctrlX - tipHalf, ctrlY, crownX - tipHalf, crownY);
  ctx.lineTo(crownX + tipHalf, crownY);
  ctx.quadraticCurveTo(ctrlX + baseHalf, ctrlY, cx + baseHalf, cy);
  ctx.closePath();
  ctx.fill();

  // Fronds fan from just-left-of-horizontal round to just-right-of-horizontal,
  // i.e. angles π…2π in canvas space (y grows downward, so that arc points up).
  // Annotated `number`, not left to infer the literal 7: the divide-by-zero
  // guard below is otherwise statically dead and TS rejects the comparison.
  const fronds: number = 7;
  // Short and fat, never long and thin: slender blades vanish into antialiasing
  // at ~40px tall, which is exactly the size this glyph has to survive at.
  const len = h * 0.44;
  for (let i = 0; i < fronds; i++) {
    const t = i / (fronds - 1);
    const a = Math.PI * (1.03 + 0.94 * t);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // Gravity droop: outer fronds sag more than the central one.
    const droop = h * 0.16 * (0.35 + Math.abs(t - 0.5) * 2);
    const tipX = crownX + dx * len;
    const tipY = crownY + dy * len + droop;
    // Perpendicular to the frond axis, used to bow the two edges of the blade.
    const px = -dy;
    const py = dx;
    const bow = h * 0.145;
    const midX = crownX + dx * len * 0.5;
    const midY = crownY + dy * len * 0.5 + droop * 0.28;
    ctx.beginPath();
    ctx.moveTo(crownX, crownY);
    ctx.quadraticCurveTo(midX + px * bow, midY + py * bow, tipX, tipY);
    ctx.quadraticCurveTo(midX - px * bow, midY - py * bow, crownX, crownY);
    ctx.closePath();
    ctx.fill();
  }

  // Two coconuts under the crown — the detail that removes all ambiguity.
  const nut = h * 0.045;
  ctx.beginPath();
  ctx.arc(crownX - nut * 1.3, crownY + nut * 1.6, nut, 0, TAU);
  ctx.arc(crownX + nut * 1.4, crownY + nut * 2.1, nut * 0.9, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/* -------------------------------------------------------------------- rules */

/** Sine rule. Sampled every 3px rather than bezier-approximated — cheap and exact. */
export function drawWaveBorder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  amplitude: number,
  wavelength: number,
  color: string,
  thickness: number,
): void {
  if (w <= 0 || wavelength <= 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  const stepPx = 3;
  for (let dx = 0; dx <= w; dx += stepPx) {
    const py = y + Math.sin((dx / wavelength) * TAU) * amplitude;
    if (dx === 0) ctx.moveTo(x, py);
    else ctx.lineTo(x + dx, py);
  }
  // Guarantee the run ends exactly on `w` even when it isn't a multiple of step.
  ctx.lineTo(x + w, y + Math.sin((w / wavelength) * TAU) * amplitude);
  ctx.stroke();
  ctx.restore();
}

/** Ticket-stub punched holes along a horizontal line. */
export function drawPerforation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  radius: number,
  spacing: number,
  color: string,
): void {
  if (w <= 0 || spacing <= 0 || radius <= 0) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  // Start half a pitch in so the run is visually centred on the span.
  for (let cx = x + spacing / 2; cx <= x + w; cx += spacing) {
    ctx.moveTo(cx + radius, y);
    ctx.arc(cx, y, radius, 0, TAU);
  }
  ctx.fill();
  ctx.restore();
}

/** Decorative variable-width bars. Deterministic for a given seed. */
export function drawBarcode(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  seed: number,
  color: string,
): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  const rng = makeRng(seed);
  ctx.save();
  ctx.fillStyle = color;
  const unit = Math.max(1, rect.w / 60);
  let cursor = rect.x;
  let ink = true;
  const end = rect.x + rect.w;
  while (cursor < end) {
    const width = unit * (1 + Math.floor(rng() * 3));
    const drawn = Math.min(width, end - cursor);
    if (ink) ctx.fillRect(cursor, rect.y, drawn, rect.h);
    cursor += drawn;
    ink = !ink;
  }
  ctx.restore();
}

/* --------------------------------------------------------------------- text */

/**
 * Measure `text` with the current font, adding manual tracking between glyphs.
 * The trailing gap is excluded so the result is a true ink-to-ink advance.
 */
export function measureTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
): number {
  if (!text) return 0;
  const glyphs = Array.from(text);
  let total = 0;
  for (const g of glyphs) total += ctx.measureText(g).width;
  return total + letterSpacing * Math.max(0, glyphs.length - 1);
}

/**
 * Letter-spaced fillText.
 *
 * Canvas `ctx.letterSpacing` only shipped in Safari 17.4, and a lot of this
 * event's audience is on older iPhones, so tracking is done by hand: measure
 * each glyph, advance the pen manually. Honours the current `ctx.textAlign`.
 */
export function drawTextTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number,
): void {
  if (!text) return;
  const total = measureTracked(ctx, text, letterSpacing);
  const align = ctx.textAlign;
  let pen = x;
  if (align === "center") pen = x - total / 2;
  else if (align === "right" || align === "end") pen = x - total;

  ctx.save();
  ctx.textAlign = "left";
  for (const g of Array.from(text)) {
    ctx.fillText(g, pen, y);
    pen += ctx.measureText(g).width + letterSpacing;
  }
  ctx.restore();
}

/**
 * Shrink until it fits. Returns the chosen px size; the caller is expected to
 * set `ctx.font` itself afterwards (this restores whatever font was active, so
 * it can be called mid-layout without side effects).
 *
 * Binary search rather than a decrement loop: names can be long enough that a
 * 1px-at-a-time walk from 96 to 40 costs 56 measureText calls per redraw, and
 * the editor redraws on every drag frame.
 */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  family: string,
  startSize: number,
  minSize: number,
  weight: number | string = 400,
  letterSpacing = 0,
): number {
  if (!text) return minSize;
  const prev = ctx.font;
  const widthAt = (size: number): number => {
    ctx.font = fontString(size, family, weight);
    return measureTracked(ctx, text, letterSpacing);
  };
  let result = minSize;
  if (widthAt(startSize) <= maxWidth) {
    result = startSize;
  } else {
    // Invariant: `lo` always fits (or is the floor), `hi` never fits.
    let lo = minSize;
    let hi = startSize;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (widthAt(mid) <= maxWidth) lo = mid;
      else hi = mid;
    }
    result = lo;
  }
  ctx.font = prev;
  return result;
}

/* ----------------------------------------------------------------- arc text */

export interface ArcTextOptions {
  /**
   * Bottom-of-circle mode. Reverses the sweep and rotates glyphs the other way
   * so the text reads left-to-right along the bottom instead of upside down.
   */
  flip?: boolean;
  letterSpacing?: number;
  /** Only "center" is meaningful today; the run is centred in [start, end]. */
  align?: "center";
  /** Shrink the font if the run would overflow the span. Default true. */
  autoFit?: boolean;
}

/** A chunk of text that gets placed on the arc as a single rigid unit. */
interface ArcRun {
  text: string;
  /** Advance width at the active font. */
  width: number;
}

const DEVANAGARI_RE = /[ऀ-ॿ᳐-᳹꠰-ꣿ]/;

/**
 * How far to nudge the draw point so the *ink* — not the em box — is centred on
 * the arc radius.
 *
 * `textBaseline: "middle"` centres the em square, and these display faces carry
 * a tall Devanagari ascent with almost no Latin descent, so all-caps text ends
 * up sitting well above the em centre. On a ring that reads as the wordmark
 * drifting outward along the top and inward along the bottom — the single most
 * obvious flaw on the PFP. Measuring the real ink box removes it entirely.
 *
 * Ink spans [-ascent, +descent] around the alphabetic baseline, so shifting the
 * baseline down by (ascent − descent) / 2 puts the ink centre on the radius.
 */
function inkCenterOffset(ctx: CanvasRenderingContext2D, text: string): number {
  const m = ctx.measureText(text);
  const asc = m.actualBoundingBoxAscent;
  const desc = m.actualBoundingBoxDescent;
  // Pre-2019 Safari lacks actualBoundingBox*; falling back to 0 just restores
  // the old em-box behaviour rather than throwing.
  if (!Number.isFinite(asc) || !Number.isFinite(desc)) return 0;
  return (asc - desc) / 2;
}

/**
 * Split into arc-able units.
 *
 * Latin is split per grapheme so it can genuinely curve. Devanagari must NOT
 * be: the script stacks matras and forms conjuncts across code points, and
 * drawing each code unit at its own angle shreds "गोवा" into disconnected marks.
 * So any Devanagari run is kept whole and placed tangentially at its midpoint —
 * over a short word on a 468px radius the loss of curvature is invisible.
 */
function segmentArcRuns(
  ctx: CanvasRenderingContext2D,
  text: string,
): ArcRun[] {
  const runs: ArcRun[] = [];
  let buffer = "";
  const flushDevanagari = (): void => {
    if (!buffer) return;
    runs.push({ text: buffer, width: ctx.measureText(buffer).width });
    buffer = "";
  };
  for (const ch of Array.from(text)) {
    if (DEVANAGARI_RE.test(ch)) {
      buffer += ch;
    } else {
      flushDevanagari();
      runs.push({ text: ch, width: ctx.measureText(ch).width });
    }
  }
  flushDevanagari();
  return runs;
}

/**
 * Lay `text` along a circular arc.
 *
 * Angles are canvas-native: 0 = 3 o'clock, +π/2 = 6 o'clock, -π/2 = 12 o'clock.
 *  - Top arc  (flip false): pass roughly (-π, 0); the sweep runs 9 → 12 → 3 and
 *    each glyph is rotated θ + π/2, which is upright at the top.
 *  - Bottom arc (flip true): the sweep runs the other way, 9 → 6 → 3, and the
 *    rotation is θ − π/2, which is upright at the bottom.
 * Either way the run is centred on the midpoint of [startAngle, endAngle].
 */
export function drawArcText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  font: string,
  color: string,
  options: ArcTextOptions = {},
): void {
  if (!text || radius <= 0) return;
  const letterSpacing = options.letterSpacing ?? 0;
  const flip = options.flip ?? false;
  const autoFit = options.autoFit ?? true;

  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  let runs = segmentArcRuns(ctx, text);
  const linearWidth = (list: ArcRun[]): number =>
    list.reduce((sum, r) => sum + r.width, 0) +
    letterSpacing * Math.max(0, list.length - 1);

  let totalAngle = linearWidth(runs) / radius;
  const span = Math.abs(endAngle - startAngle);

  // Overflow guard: a long arc run silently wrapping past its neighbours is the
  // ugliest failure mode on the PFP, so shrink once to fit rather than collide.
  if (autoFit && span > 0 && totalAngle > span) {
    const match = /(\d+(?:\.\d+)?)px/.exec(font);
    const currentSize = match?.[1] !== undefined ? Number(match[1]) : 0;
    if (currentSize > 0) {
      const shrunk = Math.max(8, currentSize * (span / totalAngle));
      ctx.font = font.replace(/(\d+(?:\.\d+)?)px/, `${shrunk.toFixed(2)}px`);
      runs = segmentArcRuns(ctx, text);
      totalAngle = linearWidth(runs) / radius;
    }
  }

  // One offset for the whole string, not per glyph — otherwise "O" and "'" would
  // land on different radii and the run would visibly ripple.
  const dy = inkCenterOffset(ctx, text);
  const dir = flip ? -1 : 1;
  const mid = (startAngle + endAngle) / 2;
  let cursor = mid - dir * (totalAngle / 2);

  for (const run of runs) {
    const halfAngle = run.width / 2 / radius;
    const theta = cursor + dir * halfAngle;
    if (run.text.trim()) {
      ctx.save();
      ctx.translate(cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius);
      ctx.rotate(theta + (dir * Math.PI) / 2);
      ctx.fillText(run.text, 0, dy);
      ctx.restore();
    }
    cursor += dir * ((run.width + letterSpacing) / radius);
  }
  ctx.restore();
}

/**
 * Explicit multi-run variant: each entry keeps its own font/colour but they are
 * measured and centred as one continuous arc. Used for mixed-script lockups
 * where the Devanagari wants a different face from the Latin.
 */
export interface ArcTextRun {
  text: string;
  font: string;
  color: string;
}

export function drawArcTextRuns(
  ctx: CanvasRenderingContext2D,
  parts: readonly ArcTextRun[],
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  options: ArcTextOptions = {},
): void {
  if (parts.length === 0 || radius <= 0) return;
  const letterSpacing = options.letterSpacing ?? 0;
  const flip = options.flip ?? false;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Flatten to placeable units first so the whole lockup can be centred.
  interface Unit {
    text: string;
    width: number;
    font: string;
    color: string;
  }
  const units: Unit[] = [];
  // Shared ink box across every part: the mixed-script lockup must sit on ONE
  // baseline, so centring each face independently would be wrong here.
  let maxAsc = 0;
  let maxDesc = 0;
  for (const part of parts) {
    ctx.font = part.font;
    if (part.text.trim()) {
      const m = ctx.measureText(part.text);
      if (Number.isFinite(m.actualBoundingBoxAscent)) {
        maxAsc = Math.max(maxAsc, m.actualBoundingBoxAscent);
      }
      if (Number.isFinite(m.actualBoundingBoxDescent)) {
        maxDesc = Math.max(maxDesc, m.actualBoundingBoxDescent);
      }
    }
    for (const run of segmentArcRuns(ctx, part.text)) {
      units.push({ text: run.text, width: run.width, font: part.font, color: part.color });
    }
  }
  const dy = (maxAsc - maxDesc) / 2;

  const total =
    units.reduce((sum, u) => sum + u.width, 0) +
    letterSpacing * Math.max(0, units.length - 1);
  const totalAngle = total / radius;
  const dir = flip ? -1 : 1;
  const mid = (startAngle + endAngle) / 2;
  let cursor = mid - dir * (totalAngle / 2);

  for (const unit of units) {
    const halfAngle = unit.width / 2 / radius;
    const theta = cursor + dir * halfAngle;
    if (unit.text.trim()) {
      ctx.save();
      ctx.font = unit.font;
      ctx.fillStyle = unit.color;
      ctx.translate(cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius);
      ctx.rotate(theta + (dir * Math.PI) / 2);
      ctx.fillText(unit.text, 0, dy);
      ctx.restore();
    }
    cursor += dir * ((unit.width + letterSpacing) / radius);
  }
  ctx.restore();
}

/**
 * Dotted leader between a label and a value, as on a printed manifest.
 * Draws dots from `x1` to `x2` at the given baseline offset.
 */
export function drawDottedLeader(
  ctx: CanvasRenderingContext2D,
  x1: number,
  x2: number,
  y: number,
  color: string,
  dotRadius: number,
  spacing: number,
): void {
  if (x2 - x1 <= spacing || spacing <= 0) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let x = x1 + spacing; x < x2 - spacing * 0.5; x += spacing) {
    ctx.moveTo(x + dotRadius, y);
    ctx.arc(x, y, dotRadius, 0, TAU);
  }
  ctx.fill();
  ctx.restore();
}
