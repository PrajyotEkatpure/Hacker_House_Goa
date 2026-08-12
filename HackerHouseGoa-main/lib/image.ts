/**
 * Photo intake: File -> SourceImage.
 *
 * Everything downstream (editor, compositors, export) assumes it is handed an
 * upright, sanely-sized `ImageBitmap`. This module is the only place that talks
 * to the browser's decoders, so it is also the only place that has to know about
 * the three things that actually break in the field:
 *
 *   1. EXIF orientation — portrait iPhone shots decode sideways unless the
 *      bitmap is requested with `imageOrientation: "from-image"`.
 *   2. HEIC — the default iPhone camera format, which Chrome/Firefox/Android
 *      cannot decode at all, so it goes through a WASM decoder.
 *   3. Memory — a 48MP original is ~190MB of RGBA. Mid-range Android kills the
 *      tab if we keep that around while also compositing 1080×1350 canvases.
 *
 * Browser-only. Every entry point guards `window` / `document` so importing this
 * from a server component is inert rather than a crash.
 */

import { LIMITS } from "./brand";
import type { SourceImage } from "./types";

/* ------------------------------------------------------------------- errors */

export type ImageLoadErrorCode = "too-large" | "unsupported" | "decode-failed";

/**
 * Every rejection from `loadImageFile` is one of these, and `message` is always
 * safe to show the user verbatim — the UI never has to map codes to copy.
 */
export class ImageLoadError extends Error {
  readonly code: ImageLoadErrorCode;

  constructor(code: ImageLoadErrorCode, message: string) {
    super(message);
    this.name = "ImageLoadError";
    this.code = code;
    // `extends Error` breaks under an ES5/ES2015 downlevel: the constructor
    // returns a plain Error and the prototype chain is lost, so `instanceof`
    // silently returns false. Re-pointing it here keeps the check honest no
    // matter what target the bundler settles on.
    Object.setPrototypeOf(this, ImageLoadError.prototype);
  }
}

/* ------------------------------------------------------------------ helpers */

/** "18.2 MB", "15 MB", "812 KB" — sized for error copy, not for tables. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let rounded = Math.round(value * 10) / 10;
  // Rounding can push a value back across the boundary it just failed to cross:
  // 1_048_575 B is 1023.999 KB, which rounds to a nonsense "1024 KB". Carry it.
  if (rounded >= 1024 && unit < units.length - 1) {
    rounded = Math.round((rounded / 1024) * 10) / 10;
    unit += 1;
  }
  // Whole numbers read better without the ".0" in a sentence.
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  // `units` is a const tuple and `unit` is clamped by the loop above, but
  // noUncheckedIndexedAccess can't see that.
  return `${text} ${units[unit] ?? "B"}`;
}

/** Byte at `i`, or -1 past the end — keeps the sniffer total over short buffers. */
function byteAt(bytes: Uint8Array, i: number): number {
  const v = bytes[i];
  return v === undefined ? -1 : v;
}

/**
 * The 4-character box type / brand at `offset`, or null if it runs off the end
 * or contains a non-printable byte (which means we are not looking at a real
 * ISO-BMFF header and should bail rather than build a garbage string).
 */
function readBrand(bytes: Uint8Array, offset: number): string | null {
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    const b = byteAt(bytes, offset + i);
    if (b < 0x20 || b > 0x7e) return null;
    out += String.fromCharCode(b);
  }
  return out;
}

/* ------------------------------------------------------------- HEIC sniffing */

/**
 * Brands that mean "this is HEIF-family payload the WASM decoder can handle".
 *
 * `mif1` / `msf1` are the generic HEIF brands and also appear in the
 * compatible-brands list of AVIF files. That false positive is harmless and
 * mildly useful: the HEIC branch only ever runs after the native decoder has
 * already failed, and libheif decodes AVIF too.
 */
const HEIC_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif",
]);

/** A real ftyp box is well under 100 bytes; anything past this is a bogus size. */
const MAX_FTYP_SCAN = 4096;

/** Enough to cover the ftyp box of every camera/phone encoder in the wild. */
const HEADER_BYTES = 256;

/**
 * Detect HEIC/HEIF from the bytes, never from the extension or the MIME type —
 * iOS hands us files typed `""` from the share sheet and `.jpg`-named HEICs
 * out of third-party apps often enough that the name is worthless.
 *
 * Layout: [uint32 box size][ "ftyp" ][ major brand ][ uint32 minor version ]
 *         [ compatible brand ][ compatible brand ]…
 */
export function sniffHeic(bytes: Uint8Array): boolean {
  // 4 size + 4 "ftyp" + 4 major brand is the smallest meaningful header.
  if (bytes.length < 12) return false;
  if (readBrand(bytes, 4) !== "ftyp") return false;

  const major = readBrand(bytes, 8);
  if (major !== null && HEIC_BRANDS.has(major)) return true;

  // Big-endian uint32; `>>> 0` because bit ops are signed in JS and a box larger
  // than 2GB would otherwise come back negative.
  const declared =
    ((byteAt(bytes, 0) << 24) |
      (byteAt(bytes, 1) << 16) |
      (byteAt(bytes, 2) << 8) |
      byteAt(bytes, 3)) >>>
    0;

  // Size 0 means "extends to end of file" and 1 means "a 64-bit size follows";
  // in both cases, and whenever the declared size overruns the slice we were
  // handed, fall back to scanning what we actually have.
  const usable = declared >= 16 && declared <= bytes.length ? declared : bytes.length;
  const end = Math.min(usable, MAX_FTYP_SCAN);

  // Compatible brands start after size(4) + "ftyp"(4) + major(4) + minor(4).
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = readBrand(bytes, offset);
    if (brand === null) break; // hit padding or the next box — stop, don't guess
    if (HEIC_BRANDS.has(brand)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ loading */

export type LoadStage = "decoding" | "converting" | "downscaling";

/**
 * Read the first bytes of a file without pulling the whole thing into memory.
 * Never rejects: a header we cannot read simply means "not HEIC", and the
 * decode attempt that follows is the real arbiter of whether the file is usable.
 */
async function readHeader(file: File): Promise<Uint8Array> {
  const slice = file.slice(0, Math.min(HEADER_BYTES, file.size));
  try {
    // Blob.arrayBuffer() is missing on Safari < 14, hence the FileReader path.
    if (typeof slice.arrayBuffer === "function") {
      return new Uint8Array(await slice.arrayBuffer());
    }
  } catch {
    /* fall through to FileReader */
  }
  return await new Promise<Uint8Array>((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(0));
      };
      reader.onerror = () => resolve(new Uint8Array(0));
      // `abort` is a third terminal state, and it really fires: an iCloud /
      // network-drive file that goes away mid-read ends there, not on `error`.
      // Without this the promise never settles and the whole upload hangs on a
      // spinner with no way out.
      reader.onabort = () => resolve(new Uint8Array(0));
      reader.readAsArrayBuffer(slice);
    } catch {
      resolve(new Uint8Array(0));
    }
  });
}

/**
 * Decode a blob to an upright bitmap.
 *
 * We decode straight from the Blob rather than via an <img> + object URL, so
 * there is no URL to leak or revoke on any path through this module.
 */
async function decodeBlob(blob: Blob): Promise<ImageBitmap> {
  try {
    // This options bag is the whole ballgame for orientation: without
    // "from-image" the EXIF rotation tag is ignored and every portrait iPhone
    // photo lands on its side.
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    // Some older Safari builds reject the options bag outright instead of
    // ignoring the unknown key. Retry bare — orientation is then browser
    // default, which on exactly those Safari builds already means "EXIF
    // applied", so the retry still comes out upright where it matters.
    return await createImageBitmap(blob);
  }
}

/** HEIC -> JPEG -> bitmap. Only ever called after the native decoder gave up. */
async function decodeHeic(file: File): Promise<ImageBitmap> {
  let jpeg: Blob;
  try {
    // Dynamic import on purpose: heic-to carries a ~1MB libheif WASM payload.
    // A static import would put it in the main chunk and every visitor — most
    // of whom upload a JPEG — would pay for it on first paint.
    const { heicTo } = await import("heic-to");
    jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
  } catch {
    throw new ImageLoadError(
      "unsupported",
      "We couldn't open that HEIC photo. On iPhone, Settings → Camera → Formats → Most Compatible saves shots as JPEG.",
    );
  }
  try {
    return await decodeBlob(jpeg);
  } catch {
    throw new ImageLoadError(
      "decode-failed",
      "That HEIC photo converted but wouldn't open. Try a JPEG or PNG instead.",
    );
  }
}

/**
 * Shrink to `LIMITS.maxSourceEdge` on the long edge, in halving steps.
 *
 * One drawImage that shrinks by more than 2× samples too few source pixels and
 * aliases badly — hair turns to sparkle, fabric moirés. Halving averages 4
 * pixels into 1 each pass, which is what every "high quality resize" trick
 * amounts to in canvas.
 *
 * Returns the original bitmap untouched if it is already small enough or if
 * anything about the canvas path is unavailable: an oversized photo still works,
 * a failed upload does not.
 */
async function downscale(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (longEdge <= LIMITS.maxSourceEdge || typeof document === "undefined") return bitmap;

  const ratio = LIMITS.maxSourceEdge / longEdge;
  const targetW = Math.max(1, Math.round(bitmap.width * ratio));
  const targetH = Math.max(1, Math.round(bitmap.height * ratio));

  let src: CanvasImageSource = bitmap;
  let srcW = bitmap.width;
  let srcH = bitmap.height;
  let spent: HTMLCanvasElement | null = null;
  let latest: HTMLCanvasElement | null = null;

  while (srcW > targetW || srcH > targetH) {
    // Never overshoot past the target on the way down.
    const nextW = Math.max(targetW, Math.round(srcW / 2));
    const nextH = Math.max(targetH, Math.round(srcH / 2));
    const canvas = document.createElement("canvas");

    // A null 2d context is not the only way this fails. Under memory pressure
    // Firefox throws out of the `canvas.width` setter and iOS Safari throws out
    // of `drawImage` when it cannot allocate the backing store. Uncaught, either
    // one rejects `loadImageFile` with a raw DOMException — which breaks the
    // "every rejection is an ImageLoadError" contract the UI codes against AND
    // leaks the decoded source bitmap, since nothing downstream closes it.
    let drawn = false;
    try {
      canvas.width = nextW;
      canvas.height = nextH;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, 0, 0, nextW, nextH);
        drawn = true;
      }
    } catch {
      /* out of GPU/canvas memory — handled by the bail-out below */
    }

    if (!drawn) {
      // Keep whatever earlier pass we already have (or the original bitmap), and
      // drop this canvas's backing store rather than waiting on GC. Guarded too:
      // if the setter is what threw above, it can throw again on the way out.
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch {
        /* nothing left to do but let GC have it */
      }
      break;
    }

    // The canvas we just read from is dead now. Zeroing its dimensions drops
    // the backing store immediately; waiting for GC is how iOS Safari ends up
    // holding several hundred MB of intermediates at once.
    if (spent) {
      spent.width = 0;
      spent.height = 0;
    }
    spent = canvas;
    latest = canvas;
    src = canvas;
    srcW = nextW;
    srcH = nextH;
  }

  if (!latest) return bitmap;

  let out: ImageBitmap;
  try {
    // No orientation option here: canvas pixels are already upright, and
    // passing "from-image" for a canvas source is a no-op at best.
    out = await createImageBitmap(latest);
  } catch {
    latest.width = 0;
    latest.height = 0;
    return bitmap;
  }
  // Only now is the oversized original unreferenced.
  bitmap.close();
  latest.width = 0;
  latest.height = 0;
  return out;
}

/**
 * Decode a user-picked file into a `SourceImage`.
 *
 * `onStage` is a progress hook for the UI — HEIC conversion of a 12MP photo can
 * take a couple of seconds on an older phone and needs its own label.
 */
export async function loadImageFile(
  file: File,
  onStage?: (s: LoadStage) => void,
): Promise<SourceImage> {
  // A UI callback must never be able to fail an upload.
  const stage = (s: LoadStage): void => {
    try {
      onStage?.(s);
    } catch {
      /* no-op */
    }
  };

  if (typeof window === "undefined" || typeof createImageBitmap !== "function") {
    throw new ImageLoadError(
      "unsupported",
      "This browser can't open photos here. Try the latest Chrome, Safari or Firefox.",
    );
  }

  if (file.size === 0) {
    throw new ImageLoadError("unsupported", "That file is empty — pick a photo to continue.");
  }

  if (file.size > LIMITS.maxUploadBytes) {
    throw new ImageLoadError(
      "too-large",
      `That photo is ${formatBytes(file.size)} — please pick one under ${formatBytes(
        LIMITS.maxUploadBytes,
      )}.`,
    );
  }

  // Sniff before decoding, not after a failure: we also need the answer in the
  // case where the browser *succeeds* but hands back a degenerate bitmap.
  const isHeic = sniffHeic(await readHeader(file));

  // Only reject when the browser positively claims a non-image media type AND the
  // bytes don't say HEIF. Anything vague goes to the decoder, which is the real
  // arbiter — the browser sniffs content, `file.type` only sniffs the extension:
  //   ""                         — plenty of legitimate iOS share-sheet picks
  //   "application/octet-stream" — what Android file managers, the Downloads
  //                                provider and drag-drop of an extensionless
  //                                file report for a perfectly good JPEG
  // Lower-cased because some Android WebViews report "IMAGE/JPEG".
  const declaredType = file.type.toLowerCase();
  const typeIsUninformative =
    declaredType === "" ||
    declaredType === "application/octet-stream" ||
    declaredType === "binary/octet-stream";
  if (!isHeic && !typeIsUninformative && !declaredType.startsWith("image/")) {
    throw new ImageLoadError(
      "unsupported",
      "That's not an image file. Pick a JPEG, PNG, WebP or HEIC photo.",
    );
  }

  stage("decoding");
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decodeBlob(file);
  } catch {
    bitmap = null;
  }

  let converted = false;
  // Two different ways a browser signals "I can't do HEIC": an outright throw
  // (desktop Chrome, Firefox) or a resolved-but-0×0 bitmap (some Android
  // WebViews). Treat both as "go through WASM".
  if (isHeic && (bitmap === null || bitmap.width === 0 || bitmap.height === 0)) {
    bitmap?.close();
    stage("converting");
    bitmap = await decodeHeic(file);
    converted = true;
  }

  if (bitmap === null || bitmap.width === 0 || bitmap.height === 0) {
    bitmap?.close();
    throw new ImageLoadError(
      "decode-failed",
      "We couldn't read that image. Try a different photo, or save it as a JPEG first.",
    );
  }

  stage("downscaling");
  const finalBitmap = await downscale(bitmap);

  return {
    bitmap: finalBitmap,
    width: finalBitmap.width,
    height: finalBitmap.height,
    converted,
  };
}
