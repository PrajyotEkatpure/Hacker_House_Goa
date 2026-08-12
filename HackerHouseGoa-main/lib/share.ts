/**
 * FrameInGoa — the share layer.
 *
 * Three routes out of the app, in order of preference:
 *   1. Native share sheet   -> shareFiles()   (mobile: puts the PNG straight into X)
 *   2. Download + X intent  -> downloadBlob() + xIntentUrl()   (desktop, and the
 *      universal fallback — X's web intent cannot accept an image, so the user
 *      attaches the downloaded file themselves)
 *   3. Copy the caption     -> copyText()     (last resort, always available)
 *
 * Everything here has to survive: SSR (no window/navigator/document), an offline
 * or unconfigured deploy (no blob store, no KV), and iOS Safari's opinions about
 * clipboards and user activation. Nothing in this file may throw at the caller
 * except uploadCard(), which is the one operation a UI can meaningfully retry.
 */

import { COHORT_SIZE, EVENT } from "@/lib/brand";
import { fallbackBuilderNumber } from "@/lib/titles";
import { clamp } from "@/lib/transform";
import type { CardsResponse, RenderFormat } from "@/lib/types";

/* ------------------------------------------------------------------- config */

/**
 * Last-resort origin, used only when neither the browser nor
 * NEXT_PUBLIC_SITE_URL can say where we live.
 *
 * Deliberately localhost and NOT a real `*.vercel.app` name. A previous version
 * hardcoded one that turned out to be another person's live project, which
 * would have put THEIR url in our share captions. In practice this constant is
 * unreachable in the browser — `window.location.origin` always wins, so a real
 * user's caption is always correct even with zero configuration.
 */
const FALLBACK_SITE = "http://localhost:3000";

/**
 * Caption budget in UTF-16 units, measured BEFORE the share URL is appended as a
 * separate `&url=` parameter.
 *
 * This is NOT `280 - 23`: a raw 260 plus a 23-char link would be 283, over the
 * limit. It works because X re-weights EVERY link to 23 characters, and this
 * caption embeds one of its own — so the weighted cost is
 * `260 - len(embedded url) + 23`, and the cap is only ever reached when that
 * embedded URL is itself ~160+ characters long. At the canonical domain the
 * caption is 129 raw / ~147 weighted including the `&url=` link; a pathological
 * domain trims to 260 raw / ~147 weighted. Both clear 280 comfortably.
 */
const MAX_CAPTION_CHARS = 260;

/** Upload can hang on a cold Vercel Blob region; the share button must not. */
const UPLOAD_TIMEOUT_MS = 20_000;

/** The counter has an instant local fallback, so it never deserves a long wait. */
const COUNTER_TIMEOUT_MS = 6_000;

/**
 * Compile-time tripwire. `EVENT.hashtag` is a literal type (brand.ts is `as const`),
 * so if anybody ever edits it this annotation stops the build. The hashtag is
 * legally load-bearing: a caption without "#FrameInGoa" makes the submission
 * auto-invalid, and that failure would otherwise be silent and unrecoverable.
 */
const REQUIRED_HASHTAG: "#FrameInGoa" = EVENT.hashtag;

/* ---------------------------------------------------------------- site url */

/**
 * Where this app is deployed, without a trailing slash.
 *
 * Runtime origin wins over the env var: preview deploys, custom domains and
 * `localhost:3000` all produce a working link with zero configuration, which is
 * the whole point — the app must be correct on a fresh clone with no .env file.
 */
export function siteUrl(): string {
  if (typeof window !== "undefined") {
    const origin = window.location.origin;
    // Sandboxed iframes and file:// documents report the string "null" here.
    if (origin.startsWith("http")) return stripTrailingSlash(origin);
  }
  // Written as a literal member access so Next can inline it at build time.
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured && configured.trim().length > 0) return stripTrailingSlash(configured.trim());
  return FALLBACK_SITE;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.replace(/\/+$/, "") : url;
}

/* ------------------------------------------------------------------ caption */

export interface CaptionOptions {
  /**
   * Whether the caption should carry the site URL in its own text.
   *
   * FALSE for the X web intent: `intent/post` appends its `url` parameter to
   * the tweet body itself, so a caption that also contains the URL produces it
   * twice in the composer. TRUE everywhere else (clipboard, Web Share `text`),
   * where nothing else is going to supply a link.
   */
  includeUrl?: boolean;
}

/**
 * The share caption. One voice, one hashtag, everywhere.
 *
 * Number padding is derived from COHORT_SIZE so it matches
 * `formatBuilderNumber` in lib/titles.ts ("#041") without either file having to
 * know about the other.
 */
export function buildCaption(builderNo: number, site: string, options: CaptionOptions = {}): string {
  const { includeUrl = true } = options;
  const n = padBuilderNo(builderNo);
  const where = stripTrailingSlash(site.trim());

  const opening = `Locked in for Hacker House Goa 🌴 Builder #${n}/${COHORT_SIZE} reporting.`;
  // "Make yours →" only earns its arrow when a URL follows it in this string.
  // For the intent variant X appends the link after the whole caption, so the
  // pointer would aim at the hashtag instead — drop it and let the appended
  // URL close the post on its own.
  const head = includeUrl ? `${opening} Make yours → ${where}` : opening;
  // The handle is nice-to-have; the hashtag is not negotiable, so they trim in
  // that order.
  const optionalTail = ` ${EVENT.handle}`;
  const requiredTail = ` ${REQUIRED_HASHTAG}`;

  let caption = `${head}${requiredTail}${optionalTail}`;
  if (caption.length > MAX_CAPTION_CHARS) caption = `${head}${requiredTail}`;
  if (caption.length > MAX_CAPTION_CHARS) {
    // Only reachable with an absurdly long custom domain. Cut the prose+URL,
    // never the hashtag.
    const room = MAX_CAPTION_CHARS - requiredTail.length;
    caption = `${truncateUtf16Safe(head, room).trimEnd()}${requiredTail}`;
  }

  // INVARIANT: the caption always contains "#FrameInGoa".
  // We repair rather than throw — a thrown error here would kill the share
  // button, whereas an appended hashtag is always a valid caption.
  if (!caption.includes(REQUIRED_HASHTAG)) caption = `${caption} ${REQUIRED_HASHTAG}`;
  return caption;
}

function padBuilderNo(builderNo: number): string {
  const width = String(COHORT_SIZE).length; // 247 -> 3 -> "#041"
  const safe = Number.isFinite(builderNo) ? clamp(Math.round(builderNo), 1, COHORT_SIZE) : 1;
  return String(safe).padStart(width, "0");
}

/**
 * A cancelled share and an aborted fetch both surface as a DOMException named
 * "AbortError". We read `.name` structurally instead of using `instanceof
 * DOMException`/`Error`, because older WebKit did not put DOMException on the
 * Error prototype chain and a false negative here would show the user an error
 * for something they chose to do.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/** Slice by UTF-16 unit, then drop a dangling high surrogate so no emoji is halved. */
function truncateUtf16Safe(input: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (input.length <= maxUnits) return input;
  const cut = input.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isLoneHighSurrogate ? cut.slice(0, -1) : cut;
}

/* --------------------------------------------------------------- x intent */

/**
 * X's web intent. `x.com/intent/post` is the current endpoint; the old
 * `twitter.com/intent/tweet` still 30x-redirects here, but going straight to the
 * canonical URL avoids a redirect hop inside an in-app browser, where redirects
 * are where sessions get lost.
 *
 * Both parameters are encoded: the caption contains `#`, `→` and an emoji, all
 * of which would otherwise terminate or corrupt the query string.
 */
export function xIntentUrl(caption: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(caption)}&url=${encodeURIComponent(url)}`;
}

/* -------------------------------------------------------------- filenames */

/** e.g. filenameFor("pfp", "Het Patel") -> "frameingoa-pfp-het-patel.png" */
export function filenameFor(format: RenderFormat, name: string): string {
  return `frameingoa-${format}-${slugify(name)}.png`;
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD") // splits "é" into "e" + combining accent…
    .replace(/\p{Mn}/gu, "") // …so the combining mark can be dropped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, ""); // the slice may have landed on a separator
  // Empty when the name is blank or entirely non-Latin (e.g. Devanagari).
  return slug.length > 0 ? slug : "builder";
}

/* --------------------------------------------------------------- download */

/** Trigger a file download. No-op during SSR. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;

  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";

  // Firefox ignores click() on an anchor that is not in the document.
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Revoking synchronously can abort the download before the browser has read
  // the blob (observed in Safari and older Chrome). A minute is far longer than
  // any browser needs and the blob is reclaimed on navigation anyway.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/* ------------------------------------------------------------ native share */

/** Can this browser put these exact files into the system share sheet? */
export function canShareFiles(files: File[]): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.canShare !== "function" || typeof navigator.share !== "function") return false;
  try {
    return navigator.canShare({ files });
  } catch {
    // Some builds throw a TypeError for unsupported payloads instead of
    // returning false.
    return false;
  }
}

/**
 * Share the rendered PNGs through the OS share sheet.
 *
 * Returns true only when the share completed. A user cancel returns false and
 * is NOT an error — callers should treat false as "still here, offer the
 * download instead", never as something to surface as a failure.
 */
export async function shareFiles(files: File[], text: string): Promise<boolean> {
  if (!canShareFiles(files)) return false;

  // Copy the caption BEFORE sharing: X (and most apps) silently drop the `text`
  // field once a file is attached, so the clipboard is the only way the user
  // gets the caption — and with it the hashtag the submission depends on.
  //
  // Deliberately NOT awaited, in either direction.
  //
  // Not before share(): navigator.share() requires transient user activation, and
  // on iOS Safari an intervening await can spend it, turning the share into a
  // NotAllowedError. Kicking the copy off in the same task preserves the
  // activation for the share() call below.
  //
  // Not after it either: this promise must settle when the SHARE settles. Opening
  // the system share sheet blurs the document, and a clipboard write that is
  // still in flight at that moment can be left pending indefinitely — awaiting it
  // would hang the share button forever behind a completed share. The .catch()
  // attached right here — not some later await — is what keeps a rejected
  // clipboard promise from ever going unhandled.
  void copyText(text).catch(() => false);

  try {
    await navigator.share({ files, text });
    return true;
  } catch (err) {
    if (isAbortError(err)) return false; // user cancelled — not a failure
    // Anything else (NotAllowedError, DataError, a share target that refuses the
    // payload) is a real failure, but the UI's move is identical: fall back.
    console.warn("[share] navigator.share failed", err);
    return false;
  }
}

/* -------------------------------------------------------------- clipboard */

/** Copy text to the clipboard. Returns success; never throws. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof document === "undefined") return false;

  try {
    // navigator.clipboard is undefined on insecure origins, and iOS Safari has
    // shipped versions that reject writeText outside a user gesture.
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path
  }

  return legacyCopy(text);
}

/** document.execCommand("copy") via a hidden textarea. Deprecated, still the only
 *  thing that works on older iOS Safari and inside some in-app browsers. */
function legacyCopy(text: string): boolean {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  // Off-screen but still rendered: display:none or visibility:hidden makes the
  // selection uncopyable. `font-size:16px` stops iOS from zooming the viewport
  // when the textarea is briefly focused.
  ta.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;font-size:16px;";
  document.body.appendChild(ta);

  let ok = false;
  try {
    // iOS ignores textarea.select() on a readonly field; selecting an explicit
    // range of the node contents is the documented workaround.
    const range = document.createRange();
    range.selectNodeContents(ta);
    selection?.removeAllRanges();
    selection?.addRange(range);
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    ta.remove();
    // Restore whatever the user had selected before we hijacked it.
    if (previous) {
      selection?.removeAllRanges();
      selection?.addRange(previous);
    }
  }
  return ok;
}

/* ------------------------------------------------------------------ upload */

/**
 * Persist the pair of PNGs so the shared link unfurls with the user's own card.
 * Throws with a human-readable message — this is the one call a UI can retry.
 */
export async function uploadCard(main: Blob, og: Blob): Promise<CardsResponse> {
  const form = new FormData();
  // Filenames matter: the route reads them for the stored blob's extension, and
  // some servers reject a FormData file part with no filename at all.
  form.append("main", asPng(main), "main.png");
  form.append("og", asPng(og), "og.png");

  // AbortController rather than AbortSignal.timeout — the latter is missing on
  // iOS Safari < 16, which is squarely inside our audience.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  // The timer has to stay armed across the RESPONSE BODY too, not just the
  // headers. fetch() resolves as soon as the headers land; on flaky venue wifi
  // the body can then stall indefinitely, and a timer already cleared leaves
  // nothing to abort the read — res.json() would never settle and the share
  // button would spin forever. Aborting mid-body errors the stream instead, so
  // every path below reaches a thrown, human-readable message.
  try {
    let res: Response;
    try {
      res = await fetch("/api/cards", { method: "POST", body: form, signal: controller.signal });
    } catch (err) {
      if (isAbortError(err)) throw new Error("Upload timed out. Your images are ready to download.");
      throw new Error("Could not reach the server. Your images are ready to download.");
    }

    if (!res.ok) throw new Error(await readApiError(res));

    const data: unknown = await res.json().catch(() => null);
    if (!isCardsResponse(data)) {
      // A body aborted by our own timeout parses as null too — say so honestly
      // rather than blaming the server for a response it never finished sending.
      throw new Error(
        controller.signal.aborted
          ? "Upload timed out. Your images are ready to download."
          : "The server sent back an unexpected response.",
      );
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** canvasToPngBlob already yields image/png, but a re-wrapped or cached Blob can
 *  arrive typeless, and the API route validates the part's MIME type. */
function asPng(blob: Blob): Blob {
  return blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
}

async function readApiError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body as { error: unknown };
      if (typeof error === "string" && error.length > 0) return error;
    }
  } catch {
    // Non-JSON body (an HTML error page from an edge proxy, usually).
  }
  return `Upload failed (${res.status}).`;
}

function isCardsResponse(value: unknown): value is CardsResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.mainUrl === "string" && typeof v.ogUrl === "string";
}

/* ----------------------------------------------------------------- counter */

/**
 * The live cohort counter, with a deterministic local fallback.
 *
 * NEVER throws and always returns 1…COHORT_SIZE. The badge number is printed
 * into the artwork, so "no number" is not a state the renderer can handle — and
 * the app has to work on a fresh clone with no KV configured at all.
 */
export async function fetchBuilderNumber(name: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COUNTER_TIMEOUT_MS);

  try {
    const res = await fetch("/api/counter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: controller.signal,
    });
    if (!res.ok) return safeBuilderNumber(name);

    const data: unknown = await res.json();
    if (typeof data === "object" && data !== null) {
      const { number } = data as { number: unknown };
      if (typeof number === "number" && Number.isFinite(number)) {
        const n = Math.round(number);
        if (n >= 1 && n <= COHORT_SIZE) return n;
      }
    }
  } catch {
    // Offline, aborted, CORS, non-JSON — all identical from here.
  } finally {
    clearTimeout(timer);
  }

  return safeBuilderNumber(name);
}

/** Belt-and-braces around the hash fallback so the 1…COHORT_SIZE promise holds
 *  even if titles.ts ever regresses. */
function safeBuilderNumber(name: string): number {
  const n = fallbackBuilderNumber(name);
  return Number.isFinite(n) ? clamp(Math.round(n), 1, COHORT_SIZE) : 1;
}
