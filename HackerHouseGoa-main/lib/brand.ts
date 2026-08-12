/**
 * FrameInGoa — single source of truth for the "retro Goan matchbox" design system.
 *
 * SWAP POINT: when the official HH Goa Brand Kit lands in /public/brand, this is
 * the only file that needs editing (plus dropping the SVG/PNG files themselves).
 * Nothing else in the codebase hardcodes a colour, an event string, or a font name.
 */

/* ------------------------------------------------------------------ palette */

export const COLORS = {
  green: "#1E4D2B", // deep palm green — primary background
  cream: "#FFF3DC", // aged paper
  red: "#E23B22", // chili / tomato red — accents
  yellow: "#F2B705", // mustard sun
  ink: "#17130E", // near-black text
} as const;

export type BrandColor = keyof typeof COLORS;

/** Derived tints used by the compositors. Kept here so restyling stays one-file. */
export const TINTS = {
  greenDeep: "#14361E", // shadow side of the palm green
  greenLight: "#2A6B3C", // lit side of the palm green
  creamShadow: "#EADCC0", // paper in shadow
  redDeep: "#B32A16",
  yellowDeep: "#D19A04",
} as const;

/* -------------------------------------------------------------------- fonts */

/**
 * Font family names as registered with the browser. These strings are used BOTH
 * in CSS (`font-family`) and in canvas (`ctx.font`), so they must match exactly
 * what `lib/fonts.ts` registers via the FontFace API.
 */
export const FONTS = {
  display: "Rozha One", // headlines, names (has Devanagari)
  accent: "Yatra One", // गोवा accents + rubber stamps (has Devanagari)
  data: "Space Grotesk", // data fields, labels, mono-ish text
} as const;

/** Appended to every canvas `ctx.font` string so missing glyphs still render. */
export const FONT_FALLBACK = "system-ui, sans-serif";

/* ------------------------------------------------------------ event strings */

/**
 * Every string that appears in an export. Editing these restyles the copy
 * across both formats and the share captions at once.
 */
export const EVENT = {
  /** Latin + Devanagari lockup. Rendered with display/accent fonts side by side. */
  wordmarkLatin: "HACKER HOUSE",
  wordmarkDevanagari: "गोवा",
  wordmark: "HACKER HOUSE गोवा",
  dates: "GOA, INDIA · 28–31 OCT 2026",
  datesShort: "OPEN TRIALS · OCT 28–31",
  studio: "2:47 PM STUDIO",
  tagline: "LESS NOISE. MORE SIGNAL",
  motto: "SHIP OR SHIP",
  cohort: "247 BUILDERS",
  hashtag: "#FrameInGoa",
  handle: "@247pmstudio",
  pfpArcTop: "HACKER HOUSE गोवा",
  pfpArcBottom: "GOA '26 · #FrameInGoa",
} as const;

/** Total cohort size — the denominator in "BUILDER #041 / 247". */
export const COHORT_SIZE = 247;

/* --------------------------------------------------------------- geometries */

/** Format A — X profile picture. Square. */
export const PFP = {
  size: 1080,
  /** Outer radius of the coloured ring, as a fraction of size/2. */
  ringOuter: 1.0,
  /** Where the photo disc ends and the ring begins. */
  ringInner: 0.735,
} as const;

/** Format B — Builder ID card. 4:5 so it is full-bleed in the X feed. */
export const CARD = {
  width: 1080,
  height: 1350,
} as const;

/** Open Graph variant composed client-side for link unfurls. */
export const OG = {
  width: 1200,
  height: 630,
} as const;

/* ------------------------------------------------------------------- assets */

/**
 * Brand assets live in /public/brand. These are placeholder SVGs drawn in the
 * matchbox style; dropping the official Brand Kit files at the same paths is a
 * zero-code swap. Every asset is optional at runtime — the compositors fall
 * back to procedurally drawn glyphs if a file fails to load, so an incomplete
 * Brand Kit can never break an export.
 */
export const BRAND_ASSETS = {
  logo: "/brand/logo.svg",
  sun: "/brand/sun.svg",
  palm: "/brand/palm.svg",
  wave: "/brand/wave.svg",
} as const;

/* -------------------------------------------------------------------- limits */

export const LIMITS = {
  /** Rejected above this with a friendly message. */
  maxUploadBytes: 15 * 1024 * 1024,
  /** Long edge the source photo is downscaled to before editing (memory safety). */
  maxSourceEdge: 2400,
  /** Per-file ceiling accepted by /api/cards. */
  maxStoredBytes: 8 * 1024 * 1024,
} as const;
