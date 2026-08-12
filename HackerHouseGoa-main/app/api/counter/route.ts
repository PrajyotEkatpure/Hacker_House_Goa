/**
 * /api/counter — the number in "BUILDER #041 / 247".
 *
 * Contractually infallible. The client renders this number straight onto a
 * canvas the user is about to post, so there is no sensible "error" UI: every
 * path here ends in a 200 with a usable number. When a KV store is wired up the
 * number is a real, live, monotonically-issued cohort position; when it is not
 * (local dev, a fresh deploy with zero env configuration) it degrades silently
 * to the deterministic name-hash from lib/titles.ts. The UI does not
 * distinguish the two — `live` exists only for analytics/debugging.
 */

import { NextResponse } from "next/server";

import { COHORT_SIZE } from "@/lib/brand";
import { fallbackBuilderNumber } from "@/lib/titles";
import type { CounterResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Redis key. The colon is legal in a URL path segment, so it needs no escaping. */
const COUNTER_KEY = "frameingoa:builders";

/**
 * A slow KV is worse than no KV — the user is staring at a spinner between
 * "upload photo" and "see my card". Bail well inside any reasonable perceived
 * wait and use the fallback.
 */
const KV_TIMEOUT_MS = 2000;

interface KvConfig {
  url: string;
  token: string;
}

/**
 * Vercel KV and Upstash-native integrations inject the same REST endpoint under
 * two different names; accept either so the operator does not have to rename
 * anything. `||` rather than `??` on purpose: a var that is set but empty is
 * "not configured", not "configured as empty string".
 *
 * No SDK is used — the Upstash REST protocol is a plain HTTP GET/POST, and this
 * project takes no new npm dependencies.
 */
function kvConfig(): KvConfig | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // Trailing slashes would produce `//incr/...`, which Upstash 404s.
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * Upstash answers `{ "result": <value> }`. INCR gives a JSON number; GET gives
 * the stored value as a *string* (or null when the key was never written), so
 * both shapes have to be accepted.
 */
function readNumericResult(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null || !("result" in payload)) return null;
  const result: unknown = payload.result;
  if (typeof result === "number") return Number.isFinite(result) ? result : null;
  if (typeof result === "string") {
    const parsed = Number.parseInt(result, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Runs one Upstash REST command. Returns null on *any* problem — never throws. */
async function kvCommand(cfg: KvConfig, method: "GET" | "POST", command: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KV_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.url}/${command}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const payload: unknown = await res.json();
    return readNumericResult(payload);
  } catch {
    // Abort (timeout), DNS failure, TLS error, non-JSON body — all identical
    // from here: no number, use the fallback.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A live counter keeps climbing past 247, but the badge reads "#N / 247" and
 * must stay inside the cohort. Wrap rather than clamp so builder 248 gets #1
 * again instead of everyone after 247 sharing the same number.
 */
function wrapIntoCohort(n: number): number {
  const i = Math.trunc(n);
  // ((i - 1) % SIZE) + 1 goes negative for i < 1, which INCR never returns, but
  // a corrupted key could. Floor it at the first slot.
  if (i < 1) return 1;
  return ((i - 1) % COHORT_SIZE) + 1;
}

/** Body is `{ name?: string }`; anything else (empty, HTML, garbage) means "". */
async function readName(req: Request): Promise<string> {
  try {
    const body: unknown = await req.json();
    if (typeof body === "object" && body !== null && "name" in body && typeof body.name === "string") {
      return body.name;
    }
  } catch {
    // No body / not JSON. The fallback hashes "" and still yields a number.
  }
  return "";
}

/**
 * The last line of defence for the "never throws" promise: even if the hash
 * helper somehow blew up, the user still gets a badge number.
 */
function safeFallback(name: string): number {
  try {
    return fallbackBuilderNumber(name);
  } catch {
    return 1;
  }
}

function ok(body: CounterResponse): NextResponse<CounterResponse> {
  return NextResponse.json<CounterResponse>(body, { headers: { "cache-control": "no-store" } });
}

/* --------------------------------------------------------------- handlers */

/** Issues (and consumes) the next cohort slot. */
export async function POST(req: Request): Promise<NextResponse<CounterResponse>> {
  let name = "";
  try {
    name = await readName(req);
    const cfg = kvConfig();
    if (cfg !== null) {
      const raw = await kvCommand(cfg, "POST", `incr/${COUNTER_KEY}`);
      if (raw !== null && raw >= 1) return ok({ number: wrapIntoCohort(raw), live: true });
    }
  } catch {
    // Unreachable in practice — every helper above swallows its own failures —
    // but this endpoint is not allowed to 500 under any circumstances.
  }
  return ok({ number: safeFallback(name), live: false });
}

/**
 * Read-only peek for the "N generated" stat on the landing page.
 *
 * Deliberately NOT wrapped into 1..COHORT_SIZE: this is a running total, and a
 * site that has produced 300 cards should say 300, not 53. Callers that need a
 * badge number use POST. Zero means "unknown / not configured".
 */
export async function GET(): Promise<NextResponse<CounterResponse>> {
  try {
    const cfg = kvConfig();
    if (cfg !== null) {
      const raw = await kvCommand(cfg, "GET", `get/${COUNTER_KEY}`);
      if (raw !== null && raw >= 0) return ok({ number: Math.trunc(raw), live: true });
    }
  } catch {
    // Same contract as POST: degrade, never throw.
  }
  return ok({ number: 0, live: false });
}
