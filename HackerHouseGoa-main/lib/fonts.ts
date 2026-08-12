/**
 * Canvas font registration.
 *
 * Canvas does NOT wait for webfonts. If `ctx.fillText` runs before the face is
 * loaded, the browser silently falls back to a system font and the first export
 * comes out looking wrong — the classic "first render uses the wrong font" bug.
 * So every compositor awaits `ensureFontsReady()` before its first draw call.
 *
 * The faces are self-hosted from /public/fonts (copied out of @fontsource at
 * install time) rather than fetched from Google. Two reasons: the app then
 * builds and runs with no network at all, and canvas needs a stable URL that
 * survives the build — next/font's content-hashed URLs are awkward to hand to
 * the FontFace constructor.
 *
 * Rozha One and Yatra One ship split Latin / Devanagari subsets. Both are
 * registered under the same family name with their `unicodeRange`, so a mixed
 * string like "HACKER HOUSE गोवा" renders correctly from a single ctx.font.
 */

import { FONTS } from "./brand";

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

const DEVANAGARI =
  "U+0900-097F,U+1CD0-1CF9,U+200C-200D,U+20A8,U+20B9,U+20F0,U+25CC,U+A830-A839,U+A8E0-A8FF";

interface FaceSpec {
  family: string;
  url: string;
  weight: string;
  unicodeRange: string;
}

const FACES: FaceSpec[] = [
  {
    family: FONTS.display,
    url: "/fonts/rozha-one-latin-400-normal.woff2",
    weight: "400",
    unicodeRange: LATIN,
  },
  {
    family: FONTS.display,
    url: "/fonts/rozha-one-devanagari-400-normal.woff2",
    weight: "400",
    unicodeRange: DEVANAGARI,
  },
  {
    family: FONTS.accent,
    url: "/fonts/yatra-one-latin-400-normal.woff2",
    weight: "400",
    unicodeRange: LATIN,
  },
  {
    family: FONTS.accent,
    url: "/fonts/yatra-one-devanagari-400-normal.woff2",
    weight: "400",
    unicodeRange: DEVANAGARI,
  },
  {
    family: FONTS.data,
    url: "/fonts/space-grotesk-latin-400-normal.woff2",
    weight: "400",
    unicodeRange: LATIN,
  },
  {
    family: FONTS.data,
    url: "/fonts/space-grotesk-latin-500-normal.woff2",
    weight: "500",
    unicodeRange: LATIN,
  },
  {
    family: FONTS.data,
    url: "/fonts/space-grotesk-latin-700-normal.woff2",
    weight: "700",
    unicodeRange: LATIN,
  },
];

let readyPromise: Promise<void> | null = null;

/**
 * Idempotent: registers every face once and resolves when all of them are
 * usable by canvas. Safe to await before every draw — subsequent calls return
 * the same settled promise.
 *
 * Never rejects. If a face fails to load we still resolve, because shipping an
 * export in a fallback font beats showing the user an error.
 */
export function ensureFontsReady(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const loads = FACES.map(async (spec) => {
      try {
        const face = new FontFace(spec.family, `url(${spec.url}) format("woff2")`, {
          weight: spec.weight,
          style: "normal",
          unicodeRange: spec.unicodeRange,
          display: "block",
        });
        await face.load();
        document.fonts.add(face);
      } catch {
        // A missing subset degrades to the fallback family for those glyphs only.
      }
    });
    await Promise.all(loads);
    try {
      await document.fonts.ready;
    } catch {
      /* no-op */
    }
  })();

  return readyPromise;
}
