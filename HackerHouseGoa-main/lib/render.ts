/**
 * render — the two compositors. These exported PNGs *are* the product.
 *
 * Everything draws in DESIGN SPACE (1080×1080 for the PFP, 1080×1350 for the
 * card). The caller decides resolution: the editor applies `ctx.scale()` for a
 * small preview, `renderToCanvas` uses a 1:1 canvas for the export. One code
 * path, so the preview can never drift from the download.
 *
 * Layout numbers below are hand-budgeted and commented with their running
 * totals — see CARD_L. If you move one, re-check the two neighbours.
 */

import {
  annulusPath,
  drawArcText,
  drawArcTextRuns,
  drawBarcode,
  drawDottedLeader,
  drawGrain,
  drawPalmGlyph,
  drawPerforation,
  drawSunGlyph,
  drawSunburst,
  drawTextTracked,
  drawWaveBorder,
  fitText,
  fontString,
  measureTracked,
  roundRectPath,
} from "./canvasKit";
import { CARD, COLORS, EVENT, FONTS, OG, PFP, TINTS } from "./brand";
import { ensureFontsReady } from "./fonts";
import { drawPhoto } from "./transform";
import { formatBuilderNumber, maskPhone } from "./titles";
import type { Rect, RenderFormat, RenderInput } from "./types";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* --------------------------------------------------------------- geometries */

export function designSizeFor(format: RenderFormat): { width: number; height: number } {
  if (format === "pfp") return { width: PFP.size, height: PFP.size };
  return { width: CARD.width, height: CARD.height };
}

/* ------------------------------------------------------------- PFP geometry */

const PFP_CENTER = PFP.size / 2; // 540
const PFP_OUTER_R = (PFP.size / 2) * PFP.ringOuter; // 540
const PFP_DISC_R = (PFP.size / 2) * PFP.ringInner; // 396.9 — photo edge
/** Mid-line of the ring band; both arc runs sit on it. */
const PFP_ARC_R = (PFP_DISC_R + PFP_OUTER_R) / 2; // 468.45
const PFP_BAND = PFP_OUTER_R - PFP_DISC_R; // 143.1

/* ------------------------------------------------------------ CARD geometry */

/**
 * Vertical budget for the 1350px card. Running totals in the comments; the
 * elements between `nameBaseline` and `cohortBaseline` float (see FLOAT_SHARE)
 * so that collapsing an empty data row does not leave a hole.
 *
 *   0    border top
 *   20   header bar starts        ┐ 166 tall
 *   186  header bar ends          ┘
 *   202  wave rule
 *   216  photo block top (tilted + bordered)
 *   ~690 photo block bottom incl. drop shadow
 *   764  name baseline            ← floats down when rows collapse
 *   792  title stamp box top (64 tall)
 *   892  first data divider
 *   1063 data rows end (3 × 56)
 *   1100 cohort baseline
 *   1166 builder-number baseline
 *   1190 perforation
 *   1206 footer strip starts      ┐ 124 tall
 *   1330 footer strip ends        ┘
 *   1350 border bottom
 *
 * Rebudgeted from two data rows to three (ROLE / COLLEGE / PHONE) — the photo
 * lost 25px of height and the name/stamp block tightened to pay for it.
 */
const CARD_L = {
  border: 20,
  /** Text content column. Inset further than the frame so nothing crowds it. */
  x0: 90,
  x1: 990,
  headerTop: 20,
  headerH: 166,
  lockupBaseline: 116,
  datesBaseline: 158,
  waveY: 202,
  /** Photo window in UNROTATED design space — this is what the editor drags in. */
  photo: { x: 290, y: 236, w: 500, h: 405 } as Rect,
  photoTilt: -2 * DEG,
  photoBorder: 20,
  photoRadius: 26,
  /** Sun disc behind the photo. */
  sunCx: 540,
  sunCy: 296,
  sunR: 408,
  nameBaseline: 764,
  nameMaxWidth: 900,
  stampGap: 28,
  stampH: 64,
  dividerGap: 36,
  rowH: 56,
  maxRows: 3,
  cohortBaseline: 1100,
  numberBaseline: 1166,
  perfY: 1190,
  footerTop: 1206,
  footerBottom: 1330,
} as const;

/**
 * When a data row (or the title stamp) is omitted, its height does NOT become a
 * hole. Half the freed space is pushed into the name block — moving it down
 * toward optically centred — and half is absorbed as air above the builder
 * number band. Splitting it evenly is what keeps the sparsest card (name only)
 * from looking like the bottom two thirds failed to render.
 */
const FLOAT_SHARE = 0.5;

export function photoRegionFor(format: RenderFormat): Rect {
  if (format === "pfp") {
    // The square that exactly bounds the photo disc. transform.ts cover-fits
    // into this, so the disc is always fully covered by the photo.
    const side = PFP_DISC_R * 2;
    return { x: PFP_CENTER - PFP_DISC_R, y: PFP_CENTER - PFP_DISC_R, w: side, h: side };
  }
  // Unrotated. The −2° rubber-stamp tilt is applied only while drawing, so the
  // user drags in axis-aligned space — which is exactly what feels natural.
  return { ...CARD_L.photo };
}

/* ------------------------------------------------------------------ helpers */

/** Never emit a draw call for whitespace — a stray glyph box is worse than nothing. */
function has(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The "HACKER HOUSE गोवा" lockup: Latin in the display face, Devanagari in the
 * accent face, sharing one baseline. Returns the total width actually drawn so
 * callers can place things after it.
 */
function drawWordmarkLockup(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseline: number,
  maxWidth: number,
  startSize: number,
  latinColor: string,
  devanagariColor: string,
  align: "left" | "center" = "left",
): number {
  const measure =(size: number): { latin: number; dev: number; gap: number } => {
    ctx.font = fontString(size, FONTS.display, 400);
    const latin = measureTracked(ctx, EVENT.wordmarkLatin, size * 0.03);
    ctx.font = fontString(size, FONTS.accent, 400);
    const dev = ctx.measureText(EVENT.wordmarkDevanagari).width;
    return { latin, dev, gap: size * 0.3 };
  };

  let size = startSize;
  let m = measure(size);
  const total0 = m.latin + m.gap + m.dev;
  if (total0 > maxWidth) {
    // Widths are very close to linear in font-size, so one proportional step
    // lands within a pixel or two; a second measure confirms it.
    size = Math.max(12, size * (maxWidth / total0));
    m = measure(size);
  }
  const total = m.latin + m.gap + m.dev;
  const left = align === "center" ? x - total / 2 : x;

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = fontString(size, FONTS.display, 400);
  ctx.fillStyle = latinColor;
  drawTextTracked(ctx, EVENT.wordmarkLatin, left, baseline, size * 0.03);
  ctx.font = fontString(size, FONTS.accent, 400);
  ctx.fillStyle = devanagariColor;
  ctx.fillText(EVENT.wordmarkDevanagari, left + m.latin + m.gap, baseline);
  ctx.restore();

  return total;
}

/* ================================================================= FORMAT A */

/**
 * PFP — 1080×1080.
 *
 * Read-at-48px checklist: one thick high-contrast ring, one big circular photo,
 * two bold arc runs, two solid glyphs. No hairlines that vanish when the whole
 * thing is 4.4% of its design size.
 */
function drawPfp(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { source, transform } = input;

  // 1 — ring body. Filling the whole disc green means any antialiasing gap at
  //     the photo edge shows green, never white.
  ctx.save();
  ctx.beginPath();
  ctx.arc(PFP_CENTER, PFP_CENTER, PFP_OUTER_R, 0, TAU);
  ctx.fillStyle = COLORS.green;
  ctx.fill();
  ctx.restore();

  // 1b — a faint sunburst inside the ring band gives it depth at full size and
  //      disappears politely at 48px.
  ctx.save();
  annulusPath(ctx, PFP_CENTER, PFP_CENTER, PFP_OUTER_R, PFP_DISC_R);
  ctx.clip();
  ctx.globalAlpha = 0.35;
  drawSunburst(
    ctx,
    PFP_CENTER,
    PFP_CENTER,
    PFP_OUTER_R,
    36,
    TINTS.greenLight,
    COLORS.green,
    0.04,
  );
  ctx.restore();

  // 2 — photo, circularly clipped.
  ctx.save();
  ctx.beginPath();
  ctx.arc(PFP_CENTER, PFP_CENTER, PFP_DISC_R, 0, TAU);
  ctx.clip();
  drawPhoto(ctx, source, photoRegionFor("pfp"), transform);
  ctx.restore();

  // 3 — keylines. The cream ring straddles the photo edge (centred 3px outside,
  //     12px wide) so it covers the clip seam instead of leaving a green sliver.
  ctx.save();
  ctx.lineWidth = 12;
  ctx.strokeStyle = COLORS.cream;
  ctx.beginPath();
  ctx.arc(PFP_CENTER, PFP_CENTER, PFP_DISC_R + 3, 0, TAU);
  ctx.stroke();

  ctx.lineWidth = 12;
  ctx.strokeStyle = COLORS.red;
  ctx.beginPath();
  ctx.arc(PFP_CENTER, PFP_CENTER, PFP_OUTER_R - 7, 0, TAU);
  ctx.stroke();

  // A hairline of yellow between them adds the matchbox print feel at 1080px.
  ctx.lineWidth = 4;
  ctx.strokeStyle = COLORS.yellow;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(PFP_CENTER, PFP_CENTER, PFP_DISC_R + 15, 0, TAU);
  ctx.stroke();
  ctx.restore();

  // 4 — arc text, sized off the band so it can never touch the keylines.
  //     Usable band runs from the yellow hairline (r≈414) to the red keyline
  //     (r≈527), i.e. 113px centred almost exactly on PFP_ARC_R (468). Uppercase
  //     drawn with textBaseline "middle" occupies about ±0.36em, so 0.66×143 ≈
  //     95px leaves ~19px clear on both sides. Going this large is deliberate:
  //     at 48×48 the wordmark has to survive as a legible texture.
  const arcSize = Math.round(PFP_BAND * 0.66); // 95
  // Leave 46° clear at 3 and 9 o'clock for the sun and palm glyphs.
  const clear = 23 * DEG;
  drawArcTextRuns(
    ctx,
    [
      {
        text: EVENT.wordmarkLatin,
        font: fontString(arcSize, FONTS.display, 400),
        color: COLORS.cream,
      },
      { text: " ", font: fontString(arcSize, FONTS.display, 400), color: COLORS.cream },
      {
        text: EVENT.wordmarkDevanagari,
        font: fontString(arcSize * 0.92, FONTS.accent, 400),
        color: COLORS.yellow,
      },
    ],
    PFP_CENTER,
    PFP_CENTER,
    PFP_ARC_R,
    -Math.PI + clear,
    -clear,
    { letterSpacing: 9 },
  );

  drawArcText(
    ctx,
    EVENT.pfpArcBottom,
    PFP_CENTER,
    PFP_CENTER,
    PFP_ARC_R,
    Math.PI - clear,
    clear,
    fontString(Math.round(arcSize * 0.74), FONTS.data, 700),
    COLORS.cream,
    // flip: bottom-of-circle, so the sweep reverses and glyphs rotate θ − π/2.
    { flip: true, letterSpacing: 8 },
  );

  // 5 — the two separator glyphs, sitting on the arc mid-line at 3 and 9.
  //     Both are sized to nearly fill the band: at 48px these two solid yellow
  //     marks are what makes the ring read as "a badge" rather than "a circle".
  const sunR = PFP_BAND * 0.36; // ~52 → 104 across in a 143 band
  drawSunGlyph(ctx, PFP_CENTER + PFP_ARC_R, PFP_CENTER, sunR, COLORS.yellow);
  // A palm is ~1.14× its `h` tall with its optical centre 0.57h above the base,
  // so offset the base downward to land the silhouette on the arc mid-line.
  const palmH = PFP_BAND * 0.9; // ~129 → ~114 wide, ~14px clear in the band
  drawPalmGlyph(
    ctx,
    PFP_CENTER - PFP_ARC_R,
    PFP_CENTER + palmH * 0.57,
    palmH,
    COLORS.yellow,
  );

  // 6 — grain, ring band only. Never over the face: skin tone plus noise reads
  //     as a compression artefact, not as print.
  ctx.save();
  annulusPath(ctx, PFP_CENTER, PFP_CENTER, PFP_OUTER_R, PFP_DISC_R + 9);
  ctx.clip();
  drawGrain(
    ctx,
    { x: 0, y: 0, w: PFP.size, h: PFP.size },
    0.05,
    0x5a17,
  );
  ctx.restore();
}

/* ================================================================= FORMAT B */

interface DataRow {
  label: string;
  value: string;
}

/** One label / dotted-leader / value line, plus the rule underneath it. */
function drawDataRow(ctx: CanvasRenderingContext2D, row: DataRow, top: number): void {
  const baseline = top + 40;
  ctx.save();
  ctx.textBaseline = "alphabetic";

  ctx.textAlign = "left";
  ctx.font = fontString(24, FONTS.data, 700);
  ctx.fillStyle = COLORS.green;
  ctx.globalAlpha = 0.8;
  drawTextTracked(ctx, row.label, CARD_L.x0, baseline, 4);
  const labelWidth = measureTracked(ctx, row.label, 4);
  ctx.globalAlpha = 1;

  // Value shrinks into whatever the label left over rather than colliding.
  const available = CARD_L.x1 - (CARD_L.x0 + labelWidth) - 44;
  const size = fitText(ctx, row.value, available, FONTS.data, 30, 18, 500, 1);
  ctx.font = fontString(size, FONTS.data, 500);
  ctx.textAlign = "right";
  ctx.fillStyle = COLORS.ink;
  drawTextTracked(ctx, row.value, CARD_L.x1, baseline, 1);
  const valueWidth = measureTracked(ctx, row.value, 1);

  drawDottedLeader(
    ctx,
    CARD_L.x0 + labelWidth + 14,
    CARD_L.x1 - valueWidth - 14,
    baseline - 8,
    COLORS.green,
    2.5,
    14,
  );

  // Rule closing the row.
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = COLORS.green;
  ctx.fillRect(CARD_L.x0, top + CARD_L.rowH - 2, CARD_L.x1 - CARD_L.x0, 2);
  ctx.restore();
}

/**
 * Builder ID card — 1080×1350. Drawn back to front:
 * paper → sun disc → palms → header → photo → type → footer → grain.
 */
function drawCard(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { source, transform, fields } = input;
  const W = CARD.width;
  const H = CARD.height;

  // 1 — paper + printed frame.
  ctx.save();
  ctx.fillStyle = COLORS.cream;
  ctx.fillRect(0, 0, W, H);
  // strokeRect straddles the path, and the outer half falls off-canvas, so a
  // 40px stroke on the canvas edge yields exactly a 20px inner border.
  ctx.strokeStyle = COLORS.green;
  ctx.lineWidth = CARD_L.border * 2;
  ctx.strokeRect(0, 0, W, H);
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 3;
  ctx.strokeRect(31.5, 31.5, W - 63, H - 63);
  ctx.restore();

  // 2 — sun disc rising from behind the header. Clipped to the cream area so it
  //     stops dead at the header bar instead of muddying it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    CARD_L.border,
    CARD_L.headerTop + CARD_L.headerH,
    W - CARD_L.border * 2,
    CARD_L.footerTop - (CARD_L.headerTop + CARD_L.headerH),
  );
  ctx.clip();
  ctx.beginPath();
  ctx.arc(CARD_L.sunCx, CARD_L.sunCy, CARD_L.sunR, 0, TAU);
  ctx.clip();
  drawSunburst(
    ctx,
    CARD_L.sunCx,
    CARD_L.sunCy,
    CARD_L.sunR * 1.05,
    22,
    COLORS.yellow,
    TINTS.creamShadow,
    0.07,
  );
  ctx.restore();
  // Ring around the disc, clipped the same way.
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    CARD_L.border,
    CARD_L.headerTop + CARD_L.headerH,
    W - CARD_L.border * 2,
    CARD_L.footerTop - (CARD_L.headerTop + CARD_L.headerH),
  );
  ctx.clip();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(CARD_L.sunCx, CARD_L.sunCy, CARD_L.sunR, 0, TAU);
  ctx.stroke();
  ctx.restore();

  // 3 — palms in the lower corners. Drawn early so every bit of type sits on
  //     top of them; at 8% they are paper texture, not illustration.
  ctx.save();
  ctx.globalAlpha = 0.085;
  drawPalmGlyph(ctx, 118, 1196, 250, TINTS.greenDeep);
  // Mirror rather than re-parameterise, so the two silhouettes differ.
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  drawPalmGlyph(ctx, 118, 1176, 226, TINTS.greenDeep);
  ctx.restore();

  // 4 — header bar.
  ctx.save();
  ctx.fillStyle = COLORS.green;
  ctx.fillRect(
    CARD_L.border,
    CARD_L.headerTop,
    W - CARD_L.border * 2,
    CARD_L.headerH,
  );
  ctx.fillStyle = COLORS.yellow;
  ctx.fillRect(
    CARD_L.border,
    CARD_L.headerTop + CARD_L.headerH - 8,
    W - CARD_L.border * 2,
    8,
  );
  ctx.restore();

  drawWordmarkLockup(
    ctx,
    CARD_L.x0 - 26,
    CARD_L.lockupBaseline,
    800,
    76,
    COLORS.cream,
    COLORS.yellow,
  );

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = fontString(24, FONTS.data, 500);
  ctx.fillStyle = COLORS.cream;
  ctx.globalAlpha = 0.85;
  drawTextTracked(ctx, EVENT.datesShort, CARD_L.x0 - 26, CARD_L.datesBaseline, 5);
  ctx.restore();

  drawSunGlyph(ctx, 982, 94, 42, COLORS.yellow);

  // 5 — wave rule under the header.
  drawWaveBorder(ctx, 64, CARD_L.waveY, W - 128, 8, 52, COLORS.red, 5);

  // 6 — photo window: tilted −2°, cream mount, red inner keyline, soft shadow.
  const region = CARD_L.photo;
  const pcx = region.x + region.w / 2;
  const pcy = region.y + region.h / 2;
  const b = CARD_L.photoBorder;
  ctx.save();
  ctx.translate(pcx, pcy);
  ctx.rotate(CARD_L.photoTilt);
  ctx.translate(-pcx, -pcy);

  ctx.save();
  ctx.shadowColor = "rgba(20, 54, 30, 0.38)";
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = COLORS.cream;
  roundRectPath(
    ctx,
    region.x - b,
    region.y - b,
    region.w + b * 2,
    region.h + b * 2,
    CARD_L.photoRadius + b * 0.6,
  );
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, region.x, region.y, region.w, region.h, CARD_L.photoRadius);
  ctx.clip();
  drawPhoto(ctx, source, region, transform);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 4;
  roundRectPath(
    ctx,
    region.x + 2,
    region.y + 2,
    region.w - 4,
    region.h - 4,
    CARD_L.photoRadius - 2,
  );
  ctx.stroke();
  ctx.strokeStyle = TINTS.greenDeep;
  ctx.lineWidth = 3;
  roundRectPath(
    ctx,
    region.x - b,
    region.y - b,
    region.w + b * 2,
    region.h + b * 2,
    CARD_L.photoRadius + b * 0.6,
  );
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  // 7 — collapsible data rows decide how far the name block floats down.
  const rows: DataRow[] = [];
  if (has(fields.role)) rows.push({ label: "ROLE", value: fields.role.trim() });
  if (has(fields.college)) rows.push({ label: "COLLEGE", value: fields.college.trim() });
  // PRIVACY: only ever the masked form reaches the canvas. This card is built to
  // be posted publicly, so the full number must not exist anywhere in the PNG.
  const phone = maskPhone(fields.phone);
  if (has(phone)) rows.push({ label: "PHONE", value: phone });
  const title = fields.title.trim();
  const freed =
    (CARD_L.maxRows - rows.length) * CARD_L.rowH +
    (has(title) ? 0 : CARD_L.stampGap + CARD_L.stampH);
  const nameBaseline = CARD_L.nameBaseline + freed * FLOAT_SHARE;

  // 8 — name, auto-fitted so a long one shrinks instead of running off the card.
  const name = fields.name.trim().toUpperCase();
  if (has(name)) {
    const size = fitText(ctx, name, CARD_L.nameMaxWidth, FONTS.display, 92, 42, 400, 2);
    ctx.save();
    ctx.font = fontString(size, FONTS.display, 400);
    ctx.fillStyle = TINTS.greenDeep;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    drawTextTracked(ctx, name, W / 2, nameBaseline, 2);
    ctx.restore();
  }

  // 9 — builder title as a tilted rubber stamp.
  const stampTop = nameBaseline + CARD_L.stampGap;
  if (has(title)) {
    const size = fitText(ctx, title, 720, FONTS.accent, 46, 24, 400, 1);
    ctx.save();
    ctx.font = fontString(size, FONTS.accent, 400);
    const textW = measureTracked(ctx, title, 1);
    const boxW = Math.min(880, textW + 68);
    const boxX = W / 2 - boxW / 2;
    const midY = stampTop + CARD_L.stampH / 2;
    ctx.translate(W / 2, midY);
    ctx.rotate(-2 * DEG);
    ctx.translate(-W / 2, -midY);
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 3.5;
    roundRectPath(ctx, boxX, stampTop, boxW, CARD_L.stampH, 10);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, boxX + 7, stampTop + 7, boxW - 14, CARD_L.stampH - 14, 6);
    ctx.stroke();
    ctx.fillStyle = COLORS.red;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    drawTextTracked(ctx, title, W / 2, midY + 2, 1);
    ctx.restore();
  }

  // 10 — data rows.
  const dividerY = stampTop + (has(title) ? CARD_L.stampH : 0) + CARD_L.dividerGap;
  if (rows.length > 0) {
    // With no rows this rule would be an orphan floating over empty paper.
    ctx.save();
    ctx.fillStyle = COLORS.green;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(CARD_L.x0, dividerY, CARD_L.x1 - CARD_L.x0, 3);
    ctx.restore();
  }
  rows.forEach((row, i) => {
    drawDataRow(ctx, row, dividerY + 3 + i * CARD_L.rowH);
  });

  // 11 — builder number band.
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  ctx.font = fontString(24, FONTS.data, 500);
  ctx.fillStyle = COLORS.green;
  ctx.globalAlpha = 0.65;
  drawTextTracked(ctx, EVENT.cohort, CARD_L.x1, CARD_L.cohortBaseline, 6);
  ctx.globalAlpha = 1;

  const numberText = formatBuilderNumber(fields.builderNo);
  const numSize = fitText(ctx, numberText, 640, FONTS.data, 74, 38, 700, 1);
  ctx.font = fontString(numSize, FONTS.data, 700);
  ctx.fillStyle = COLORS.green;
  drawTextTracked(ctx, numberText, CARD_L.x1, CARD_L.numberBaseline, 1);

  ctx.textAlign = "left";
  ctx.font = fontString(22, FONTS.data, 500);
  ctx.globalAlpha = 0.5;
  drawTextTracked(ctx, EVENT.studio, CARD_L.x0, CARD_L.numberBaseline, 4);
  ctx.restore();

  // 12 — torn-stub perforation just above the footer.
  ctx.save();
  ctx.globalAlpha = 0.5;
  drawPerforation(
    ctx,
    CARD_L.border + 4,
    CARD_L.perfY,
    W - (CARD_L.border + 4) * 2,
    7,
    26,
    COLORS.green,
  );
  ctx.restore();

  // 13 — footer strip.
  const fH = CARD_L.footerBottom - CARD_L.footerTop;
  ctx.save();
  ctx.fillStyle = COLORS.green;
  ctx.fillRect(CARD_L.border, CARD_L.footerTop, W - CARD_L.border * 2, fH);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.9;
  drawBarcode(ctx, { x: 60, y: 1232, w: 190, h: 48 }, 0x2b47, COLORS.cream);
  ctx.restore();

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  ctx.font = fontString(25, FONTS.data, 500);
  ctx.fillStyle = COLORS.cream;
  drawTextTracked(ctx, EVENT.tagline, 1020, 1252, 5);
  ctx.font = fontString(34, FONTS.data, 700);
  ctx.fillStyle = COLORS.yellow;
  // #FrameInGoa is load-bearing for the submission — always drawn, never fitted away.
  drawTextTracked(ctx, EVENT.hashtag, 1020, 1306, 1);
  ctx.textAlign = "left";
  ctx.font = fontString(20, FONTS.data, 500);
  ctx.fillStyle = COLORS.cream;
  ctx.globalAlpha = 0.6;
  drawTextTracked(ctx, EVENT.handle, 60, 1306, 3);
  ctx.restore();

  // 14 — grain over everything, then a yellow wave threaded through the top and
  //      bottom border strips. Grain last is what fuses photo and print together.
  drawGrain(ctx, { x: 0, y: 0, w: W, h: H }, 0.085, 0x1729);

  ctx.save();
  ctx.globalAlpha = 0.75;
  drawWaveBorder(ctx, 0, CARD_L.border / 2, W, 4, 30, COLORS.yellow, 3);
  drawWaveBorder(ctx, 0, H - CARD_L.border / 2, W, 4, 30, COLORS.yellow, 3);
  ctx.restore();
}

/* ==================================================================== entry */

/**
 * Draw one format into an already-prepared context, in design space, from (0,0).
 *
 * Fonts are awaited FIRST: canvas does not block on webfonts, so a fillText that
 * runs a frame too early silently renders in the system fallback and the very
 * first export comes out wrong.
 */
export async function drawFormat(
  ctx: CanvasRenderingContext2D,
  format: RenderFormat,
  input: RenderInput,
): Promise<void> {
  await ensureFontsReady();
  // One save/restore around everything: the editor re-draws into the same live
  // context many times per drag, so leaking any state here compounds visibly.
  ctx.save();
  try {
    if (format === "pfp") drawPfp(ctx, input);
    else drawCard(ctx, input);
  } finally {
    ctx.restore();
  }
}

/**
 * The export path. Always full design resolution, whatever the screen DPR is —
 * a retina phone and a cheap laptop must download byte-identical dimensions.
 */
export async function renderToCanvas(
  format: RenderFormat,
  input: RenderInput,
): Promise<HTMLCanvasElement> {
  const { width, height } = designSizeFor(format);
  // Deliberately NOT OffscreenCanvas: Safari's worker/offscreen 2d text stack
  // has shipped several font-metric bugs, and text is the whole design here.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get a 2D canvas context — your browser blocked canvas rendering.");
  }
  await drawFormat(ctx, format, input);
  return canvas;
}

/* -------------------------------------------------------------- OG variant */

const OG_MARGIN = 46;

/**
 * 1200×630 link-preview card: the real graphic, shrunk and mounted on a branded
 * green field with the wordmark beside it. It has to read at thumbnail size in
 * an X unfurl, so: big sunburst, big hashtag, three lines of copy maximum.
 */
export async function renderOgCanvas(
  format: RenderFormat,
  input: RenderInput,
): Promise<HTMLCanvasElement> {
  const inner = await renderToCanvas(format, input);

  const canvas = document.createElement("canvas");
  canvas.width = OG.width;
  canvas.height = OG.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get a 2D canvas context for the preview image.");
  }
  await ensureFontsReady();

  const W = OG.width;
  const H = OG.height;

  ctx.save();
  ctx.fillStyle = COLORS.green;
  ctx.fillRect(0, 0, W, H);

  // Fit the graphic to the height; width follows from its own aspect.
  const scale = (H - OG_MARGIN * 2) / inner.height;
  const gw = inner.width * scale;
  const gh = inner.height * scale;
  const gx = 78;
  const gy = (H - gh) / 2;

  // Sunburst centred on the graphic so the rays appear to come from behind it.
  ctx.save();
  ctx.globalAlpha = 0.5;
  drawSunburst(ctx, gx + gw / 2, H / 2, 900, 28, TINTS.greenLight, COLORS.green, 0.05);
  ctx.restore();

  // drawImage shadows respect source alpha, so the round PFP (transparent
  // corners) casts a round shadow and the card casts a rectangular one.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 34;
  ctx.shadowOffsetY = 14;
  ctx.drawImage(inner, gx, gy, gw, gh);
  ctx.restore();

  const textX = gx + gw + 60;
  const textW = W - textX - 78;

  drawWordmarkLockup(ctx, textX, 258, textW, 66, COLORS.cream, COLORS.yellow);

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  const hashSize = fitText(ctx, EVENT.hashtag, textW, FONTS.data, 60, 30, 700, 2);
  ctx.font = fontString(hashSize, FONTS.data, 700);
  ctx.fillStyle = COLORS.yellow;
  drawTextTracked(ctx, EVENT.hashtag, textX, 344, 2);

  const cta = "Make yours — free, no login";
  const ctaSize = fitText(ctx, cta, textW, FONTS.data, 27, 17, 500, 2);
  ctx.font = fontString(ctaSize, FONTS.data, 500);
  ctx.fillStyle = COLORS.cream;
  ctx.globalAlpha = 0.92;
  drawTextTracked(ctx, cta, textX, 404, 2);

  const datesSize = fitText(ctx, EVENT.datesShort, textW, FONTS.data, 22, 14, 500, 4);
  ctx.font = fontString(datesSize, FONTS.data, 500);
  ctx.globalAlpha = 0.62;
  drawTextTracked(ctx, EVENT.datesShort, textX, 452, 4);
  ctx.restore();

  drawWaveBorder(ctx, textX, 492, textW, 6, 40, COLORS.red, 4);
  drawSunGlyph(ctx, textX + 22, 176, 26, COLORS.yellow);

  // Cream keyline so the card has an edge against X's own background.
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = COLORS.cream;
  ctx.lineWidth = 3;
  ctx.strokeRect(18.5, 18.5, W - 37, H - 37);
  ctx.restore();

  drawGrain(ctx, { x: 0, y: 0, w: W, h: H }, 0.06, 0x0c1a);
  ctx.restore();

  return canvas;
}

/* -------------------------------------------------------------------- blob */

/** Promisified `toBlob`. Rejects loudly — a null blob means a broken download. */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode the image — try again, or use a smaller photo."));
    }, "image/png");
  });
}
