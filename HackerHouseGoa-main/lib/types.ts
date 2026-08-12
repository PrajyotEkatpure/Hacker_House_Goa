/**
 * Shared contracts. Every module in the app talks through these types.
 */

/** The two exportable graphics. */
export type RenderFormat = "pfp" | "card";

/** A decoded, EXIF-corrected, downscaled source photo ready for compositing. */
export interface SourceImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** True when the file came in as HEIC/HEIF and went through the WASM decoder. */
  converted: boolean;
}

/**
 * Pan / zoom of the photo inside its target region.
 *
 * `scale` is relative to cover-fit: 1 means the photo exactly covers the region,
 * 2 means twice that. It is never < 1, so the region can never be uncovered.
 *
 * `offsetX` / `offsetY` are expressed as a fraction of the *region's* width and
 * height, measured from centred. They are clamped by `clampTransform` so an edge
 * of the photo can never pull inside the region.
 */
export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const IDENTITY_TRANSFORM: Transform = { scale: 1, offsetX: 0, offsetY: 0 };

/** An axis-aligned rectangle in design space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The user-supplied and auto-generated text on the event ID card. */
export interface CardFields {
  /** Required. Rendered uppercase in the display face. */
  name: string;
  /** Role in the team, e.g. "DevOps Engineer". Optional. */
  role: string;
  /** College / institution, e.g. "VJTI Mumbai". Optional. */
  college: string;
  /**
   * Phone number, digits only, as typed.
   *
   * PRIVACY: this is collected in full so an organiser can match a person at
   * check-in, but the card only ever prints the last two digits — see
   * `maskPhone` in lib/titles.ts. The exported PNG is designed to be posted
   * publicly, and a full number on a public graphic is a number handed to
   * strangers. Never render this field raw.
   */
  phone: string;
  /** Auto-generated builder title, e.g. "Chai-Powered Merge Monk". */
  title: string;
  /** 1 … COHORT_SIZE. */
  builderNo: number;
}

/**
 * Everything a compositor needs to draw one export.
 *
 * IMPORTANT: compositors always draw in *design space* (1080×1080 for the PFP,
 * 1080×1350 for the card). The caller applies `ctx.scale()` beforehand to render
 * a smaller on-screen preview. That way the preview and the exported PNG go
 * through one identical code path and can never drift apart.
 */
export interface RenderInput {
  source: SourceImage;
  transform: Transform;
  fields: CardFields;
}

/** Response from POST /api/cards. */
export interface CardsResponse {
  id: string;
  mainUrl: string;
  ogUrl: string;
}

/** Every 4xx/5xx from our API routes uses this shape. */
export interface ApiError {
  error: string;
}

/** Response from POST /api/counter. */
export interface CounterResponse {
  /** 1 … COHORT_SIZE. */
  number: number;
  /** True when a real KV/Upstash INCR backed this number, false when it is the
   *  deterministic name-hash fallback. The UI does not distinguish the two. */
  live: boolean;
}
