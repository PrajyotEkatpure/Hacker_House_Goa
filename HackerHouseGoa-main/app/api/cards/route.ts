/**
 * POST /api/cards — parks the two rendered PNGs on Vercel Blob so that the
 * /c/[id] share page has something absolute to point its OG tags at.
 *
 * Design rule for this route: it is a *nice-to-have*. The client always has
 * Route 2 (Web Share) and Route 3 (download + manual post) to fall back on, so
 * every failure mode here must be a clean, typed 4xx/5xx the client can shrug
 * off — never an unhandled 500 with a stack trace.
 */

import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

import { LIMITS } from "@/lib/brand";
import type { ApiError, CardsResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------- throttling */

/**
 * Courtesy rate limit, NOT security.
 *
 * This Map lives in the memory of one serverless instance. Vercel runs many
 * instances and recycles them freely, so the real ceiling is
 * (instances x RATE_LIMIT_MAX) and it resets on every cold start. That is
 * deliberate: the goal is to blunt an accidental retry loop from a flaky phone
 * connection, not to stop a determined attacker. Real abuse protection belongs
 * at the edge (Vercel WAF / Blob quotas).
 *
 * WINDOW/MAX ARE TUNED FOR SHARED NAT — DO NOT LENGTHEN THE WINDOW. The whole
 * cohort is in one room on one venue wifi, so `x-forwarded-for` collapses all
 * 247 builders onto a single key. A long window with a low cap (the obvious
 * "10 per 10 minutes") would hand the 11th person to press "Post on X" a 429
 * and kill share route 1 for the entire venue at exactly peak load. A short
 * window with a burst allowance stops a runaway client just as well — a stuck
 * retry loop blows 20 requests in well under a minute — while leaving room for
 * a roomful of humans uploading at human speed (20/min = 1200/hour per IP).
 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
/** Hard ceiling on tracked IPs so a long-lived lambda cannot leak memory. */
const RATE_LIMIT_MAX_KEYS = 500;

const recentHits = new Map<string, number[]>();

interface RateVerdict {
  allowed: boolean;
  /** Seconds until the caller's oldest hit falls out of the window. */
  retryAfterSeconds: number;
}

function checkRateLimit(ip: string, now: number): RateVerdict {
  // Prune first: an entry whose *newest* hit is outside the window has no live
  // timestamps at all, so the whole key can go. Deleting while iterating a Map
  // is well-defined in JS.
  for (const [key, stamps] of recentHits) {
    const newest = stamps[stamps.length - 1];
    if (newest === undefined || now - newest > RATE_LIMIT_WINDOW_MS) {
      recentHits.delete(key);
    }
  }

  const live = (recentHits.get(ip) ?? []).filter((t) => now - t <= RATE_LIMIT_WINDOW_MS);
  const overLimit = live.length >= RATE_LIMIT_MAX;
  if (!overLimit) live.push(now);

  // delete-then-set moves this key to the end of the Map's insertion order, so
  // the eviction loop below behaves as a cheap LRU.
  recentHits.delete(ip);
  recentHits.set(ip, live);
  while (recentHits.size > RATE_LIMIT_MAX_KEYS) {
    const oldest = recentHits.keys().next();
    if (oldest.done) break;
    recentHits.delete(oldest.value);
  }

  if (!overLimit) return { allowed: true, retryAfterSeconds: 0 };

  const oldestStamp = live[0];
  const waitMs =
    oldestStamp === undefined ? RATE_LIMIT_WINDOW_MS : RATE_LIMIT_WINDOW_MS - (now - oldestStamp);
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    // Vercel appends hops; the first entry is the original client.
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real !== undefined && real.length > 0) return real;
  // One shared bucket for callers we cannot identify (e.g. `next dev`). Better
  // than skipping the limit entirely.
  return "unknown";
}

/* ------------------------------------------------------------- validation */

/** PNG signature, per the spec's §5.2 "PNG file signature". */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasPngMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < PNG_MAGIC.length) return false;
  const head = new Uint8Array(bytes, 0, PNG_MAGIC.length);
  // `head[i]` is `number | undefined` under noUncheckedIndexedAccess; comparing
  // undefined against a byte is simply false, which is the answer we want.
  return PNG_MAGIC.every((byte, i) => head[i] === byte);
}

/**
 * `FormDataEntryValue` is `File | string`, so excluding the string arm already
 * proves we hold a File. The extra `instanceof` is belt-and-braces against a
 * polyfilled FormData; `File` is only a global from Node 20+, so the reference
 * itself is guarded to avoid a ReferenceError on an older runtime.
 */
function asFile(value: FormDataEntryValue | null): File | null {
  if (value === null || typeof value === "string") return null;
  if (typeof File !== "undefined" && !(value instanceof File)) return null;
  return value;
}

const MAX_MB = Math.round(LIMITS.maxStoredBytes / (1024 * 1024));

/** Returns an error string, or null when the file passes every check. */
function describeFileProblem(field: string, file: File | null): string | null {
  if (file === null) return `Missing "${field}" image.`;
  if (file.size === 0) return `The "${field}" image is empty.`;
  if (file.size > LIMITS.maxStoredBytes) return `The "${field}" image is larger than ${MAX_MB}MB.`;
  // The declared type is trivially spoofable — this is only the cheap first
  // gate; hasPngMagic() below is the one that actually decides.
  if (file.type !== "image/png") return `The "${field}" image must be a PNG.`;
  return null;
}

/* --------------------------------------------------------------- plumbing */

/**
 * `put()` throws a BlobError when it can find no credentials, which would land
 * as a 500. Pre-flight the same env lookup it performs (a read-write token, or
 * an OIDC token paired with a store id) so an unconfigured local dev server or
 * preview deploy answers with a clean 503 instead. This is why the app needs
 * zero env configuration to work: sharing simply switches itself off.
 */
function hasBlobCredentials(): boolean {
  // Whitespace-only is "not set" — that is exactly how the SDK's own readEnv()
  // treats it, and a bare truthiness test here would disagree with it: a var
  // holding " " would pass this pre-flight and then throw inside put(), turning
  // the designed 503 ("sharing isn't configured") into a misleading 500
  // ("couldn't save your card"). Static member access, not process.env[name],
  // so bundler-time env substitution still sees these.
  const set = (v: string | undefined): boolean => typeof v === "string" && v.trim() !== "";
  if (set(process.env.BLOB_READ_WRITE_TOKEN)) return true;
  return set(process.env.VERCEL_OIDC_TOKEN) && set(process.env.BLOB_STORE_ID);
}

/**
 * 9 random bytes encode to exactly 12 base64url characters with no padding —
 * ~72 bits of entropy, unguessable and non-sequential, so nobody can walk the
 * /c/[id] space to enumerate other people's uploads.
 */
function generateId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

const NO_STORE = { "cache-control": "no-store" } as const;

function fail(message: string, status: number, headers?: Record<string, string>): NextResponse<ApiError> {
  return NextResponse.json<ApiError>(
    { error: message },
    { status, headers: { ...NO_STORE, ...headers } },
  );
}

/* --------------------------------------------------------------- handlers */

export async function POST(req: Request): Promise<NextResponse<CardsResponse | ApiError>> {
  try {
    // Checked before anything else so an unconfigured deploy never buffers
    // 16MB of PNG just to throw it away.
    if (!hasBlobCredentials()) {
      return fail("Sharing isn't configured yet — download the image and post it manually.", 503);
    }

    const verdict = checkRateLimit(clientIp(req), Date.now());
    if (!verdict.allowed) {
      return fail("Too many uploads from this connection. Try again in a minute.", 429, {
        "retry-after": String(verdict.retryAfterSeconds),
      });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("Expected a multipart/form-data body with `main` and `og` PNGs.", 400);
    }

    const main = asFile(form.get("main"));
    const og = asFile(form.get("og"));
    const problem = describeFileProblem("main", main) ?? describeFileProblem("og", og);
    if (problem !== null) return fail(problem, 400);
    // Both are non-null here: describeFileProblem returns a string for null and
    // we bailed on any string above.
    const mainFile = main!;
    const ogFile = og!;

    const [mainBytes, ogBytes] = await Promise.all([mainFile.arrayBuffer(), ogFile.arrayBuffer()]);
    if (!hasPngMagic(mainBytes) || !hasPngMagic(ogBytes)) {
      return fail("Those files aren't PNGs.", 400);
    }

    const id = generateId();
    const [mainBlob, ogBlob] = await Promise.all([
      put(`cards/${id}/main.png`, mainBytes, {
        access: "public",
        contentType: "image/png",
        addRandomSuffix: false,
      }),
      put(`cards/${id}/og.png`, ogBytes, {
        access: "public",
        contentType: "image/png",
        addRandomSuffix: false,
      }),
    ]);

    // put() hands back absolute https URLs on the blob store's own domain,
    // which is exactly what /c/[id] needs — X and WhatsApp will not resolve a
    // relative og:image.
    const body: CardsResponse = { id, mainUrl: mainBlob.url, ogUrl: ogBlob.url };
    return NextResponse.json<CardsResponse>(body, { headers: NO_STORE });
  } catch (err) {
    // Log server-side, tell the client nothing. A blob outage, a quota, a
    // truncated upload — all read the same from here.
    console.error("[api/cards] upload failed", err);
    return fail("Couldn't save your card. Download it and post it manually.", 500);
  }
}

/** Crawlers and curious humans hit this with GET; answer cleanly, not with a stack. */
export function GET(): NextResponse<ApiError> {
  return fail("Use POST with multipart/form-data (`main` + `og` PNGs).", 405, {
    allow: "POST",
  });
}
