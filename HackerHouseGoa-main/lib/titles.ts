/**
 * FrameInGoa — the Builder Title generator.
 *
 * DETERMINISM GUARANTEE (this is the feature, not an implementation detail)
 * ------------------------------------------------------------------------
 * The same name must ALWAYS produce the same title, on every device, forever.
 * Two people typing "Het Patel" on an iPhone and a ThinkPad must be able to
 * compare screens and see the same words — that is what makes the title feel
 * *fated* rather than randomly rolled.
 *
 * Four things make that true:
 *
 * 1. NORMALISATION. "Het  Patel", " het patel " and "HET PATEL" all collapse to
 *    the same key before hashing, so trivial typing differences do not fork the
 *    result. Unicode is NFC-normalised first: macOS hands back decomposed forms
 *    (e.g. "é" as e + U+0301) while Android/Windows hand back the composed one,
 *    and without NFC the same visible name would hash differently per platform.
 *
 * 2. INTEGER-ONLY HASHING. FNV-1a 32-bit using `Math.imul` and `>>> 0`. No
 *    floats, no `Date`, no `Math.random`, no locale-sensitive calls — so the
 *    result is bit-identical in every JS engine.
 *
 * 3. FROZEN WORD BANKS. The arrays below are positional lookup tables AND their
 *    `.length` is the modulus that turns a hash into an index. That makes them
 *    frozen in the strong sense: re-ordering, removing, *or appending* an entry
 *    changes the modulus and re-maps ~91% of existing names onto a different
 *    word (measured over 20k names for a single append). Every title already
 *    screenshotted and posted under #FrameInGoa would silently change.
 *
 *    So there is no such thing as a "safe append" here. Treat both arrays as
 *    immutable for the life of the event; growing the vocabulary means
 *    consciously accepting that the whole cohort re-rolls.
 *
 * 4. NO SIDE CHANNELS. Pure module: no DOM, no `window`, no I/O. Safe to import
 *    from a server component, a route handler, or the client bundle, and all
 *    three will agree.
 */

import { COHORT_SIZE } from "@/lib/brand";

/* ------------------------------------------------------------- word banks */

/**
 * ORDER IS PART OF THE CONTRACT — see determinism note (3) above.
 * Typed as `readonly string[]` to match the cross-module public API.
 */
export const ADJECTIVES: readonly string[] = [
  "Chai-Powered",
  "Midnight",
  "Monsoon",
  "Susegad",
  "Feral",
  "Sun-Baked",
  "Cracked",
  "Beachside",
  "Full-Moon",
  "Turbo",
];

/** ORDER IS PART OF THE CONTRACT — see determinism note (3) above. */
export const ROLES: readonly string[] = [
  "Merge Monk",
  "Vibe Compiler",
  "Deploy Pirate",
  "Prompt Whisperer",
  "Stack Sorcerer",
  "Localhost Legend",
  "Bug Bounty Baba",
  "Cabana Committer",
  "Demo Day Don",
  "Susegad Shipper",
];

/** Upper bound on the reroll search. 10×10 banks mean this is never reached. */
const MAX_REROLL_TRIES = 100;

/* ----------------------------------------------------------------- hashing */

/**
 * Collapse a display name to its hash key.
 *
 * NFC first (see determinism note 1), then case-fold, then squash every run of
 * whitespace — `\s` in JS already covers NBSP and the other Unicode spaces that
 * mobile keyboards like to insert.
 */
function normalizeName(input: string): string {
  return input.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * FNV-1a, 32-bit, returned unsigned.
 *
 * `Math.imul` is required: plain `*` on the 16777619 prime overflows into
 * double precision and silently loses the low bits, which would make the hash
 * differ from every other FNV-1a implementation (and from itself across
 * engines with different JIT rounding paths).
 *
 * Iteration is over UTF-16 code units, so astral characters (emoji names, and
 * yes people do that) contribute both surrogates. Still perfectly deterministic.
 */
export function hashString(input: string): number {
  const key = normalizeName(input);
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return h >>> 0;
}

/**
 * MurmurHash3 finalizer — an avalanche mix used to derive a SECOND, decorrelated
 * value from one hash.
 *
 * Why it matters: `h % 10` and `h % 10` obviously agree, but so do naive
 * variants like `h % 10` and `(h >>> 8) % 10` for many inputs, because FNV's low
 * bytes are weakly diffused. Without a real mix, adjective and role move
 * together and the effective variety collapses from 100 pairs toward ~10.
 */
function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/* ------------------------------------------------------------------ titles */

/**
 * Deterministic Builder Title for a name.
 *
 * `salt` exists purely so the UI's dice button can walk to a different result
 * without introducing randomness: (name, salt) is still a pure function, so a
 * shared link that carries the salt reproduces exactly what the user saw.
 *
 * An empty or whitespace-only name is fine — it hashes to the FNV basis and
 * yields a stable "default" title rather than throwing.
 */
export function titleFor(name: string, salt = 0): string {
  // Fold the salt in through the mixer instead of appending it to the string:
  // string concatenation would make salt 1 vs 11 share a prefix, and FNV's
  // sequential nature would leave those hashes suspiciously related.
  const seed = mix32(hashString(name) ^ Math.imul(salt >>> 0, 0x9e3779b1));

  const adjIndex = seed % ADJECTIVES.length;
  // Re-mix before the second pick so the two indices are independent draws.
  const roleIndex = mix32(seed ^ 0x5bf03635) % ROLES.length;

  // Non-null assertions are safe: both indices come from `% length` on a
  // non-empty frozen bank, so they are always in range. `noUncheckedIndexedAccess`
  // cannot see that invariant.
  const adjective = ADJECTIVES[adjIndex]!;
  let role = ROLES[roleIndex]!;

  // Stutter guard: "Susegad Susegad Shipper" reads as a typo, so when the role
  // already leads with the adjective we step one place along, deterministically,
  // instead of retry-looping.
  //
  // Matched STRUCTURALLY rather than against the literal indices of "Susegad" /
  // "Susegad Shipper". An index lookup (`ADJECTIVES.indexOf("Susegad")`) yields
  // -1 the moment either literal is edited — and -1 can never equal a `% length`
  // result, so the ban would switch itself off in silence. Re-spelling the Goan
  // word (Susegad / Sossegado / Sussegad) in both banks is exactly the kind of
  // edit someone makes during an event, and it must not be able to ship the
  // stutter this guard exists to prevent.
  if (role === adjective || role.startsWith(`${adjective} `)) {
    role = ROLES[(roleIndex + 1) % ROLES.length]!;
  }

  return `${adjective} ${role}`;
}

/**
 * Advance `salt` until the title visibly changes.
 *
 * The dice button must never look broken. A plain `salt + 1` can land on the
 * same pair (100 pairs, so roughly a 1-in-100 no-op), which reads as a dead tap
 * — so we scan forward for the next salt that actually produces different words
 * and hand back both the title and the salt that made it, for the caller to
 * store.
 *
 * Bounded scan, never a `while (true)`: if every probe somehow matched we return
 * the last one rather than hanging the main thread.
 */
export function rerollFrom(name: string, salt: number): { title: string; salt: number } {
  const current = titleFor(name, salt);
  let nextSalt = salt;
  let nextTitle = current;

  for (let i = 1; i <= MAX_REROLL_TRIES; i += 1) {
    nextSalt = salt + i;
    nextTitle = titleFor(name, nextSalt);
    if (nextTitle !== current) break;
  }

  return { title: nextTitle, salt: nextSalt };
}

/* ---------------------------------------------------------- builder number */

/**
 * The offline builder number: 1 … COHORT_SIZE.
 *
 * Used when /api/counter is unreachable (venue wifi at a hackathon is a
 * coin flip). Because it is name-derived it stays stable across reloads, so a
 * user who exports twice gets the same badge number both times.
 */
export function fallbackBuilderNumber(name: string): number {
  return (hashString(name) % COHORT_SIZE) + 1;
}

/* ------------------------------------------------------------------- phone */

/** Digits only, capped at 15 (E.164's maximum national-number length). */
export function sanitizePhone(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 15);
}

/**
 * What the card is allowed to print: the last two digits, everything else
 * bulleted out — `"9876543298"` → `"••••98"`.
 *
 * The exported PNG exists to be posted publicly. A full phone number on a
 * public graphic is a number handed to every stranger who sees the post, so
 * masking happens at the render boundary and there is deliberately no way to
 * ask this module for the unmasked value. An organiser checking someone in
 * still gets enough to disambiguate two people with the same name.
 *
 * Returns "" for empty input so the compositor can collapse the whole row.
 */
export function maskPhone(raw: string): string {
  const digits = sanitizePhone(raw);
  if (digits.length === 0) return "";
  // Too short to mask meaningfully — bullet the lot rather than leak a 2-digit
  // number that IS the whole number.
  if (digits.length <= 2) return "•".repeat(digits.length);
  return `${"•".repeat(Math.min(4, digits.length - 2))}${digits.slice(-2)}`;
}

/** `"BUILDER #041 / 247"` — the badge line on the ID card. */
export function formatBuilderNumber(n: number): string {
  // Guard against NaN / fractional values arriving from a JSON payload; the
  // card must render *something* legible rather than "BUILDER #NaN".
  const safe = Number.isFinite(n) ? Math.max(1, Math.min(COHORT_SIZE, Math.round(n))) : 1;
  // Width is DERIVED, not hardcoded to 3. `padBuilderNo` in lib/share.ts derives
  // its caption padding the same way, and brand.ts advertises itself as the one
  // file you edit to restyle. With a literal 3 here, bumping COHORT_SIZE to 1000
  // would print "BUILDER #41 / 1000" on the card while the caption posted
  // alongside it said "Builder #0041/1000" — same person, two numbers.
  const width = String(COHORT_SIZE).length; // 247 -> 3 -> "#041"
  return `BUILDER #${String(safe).padStart(width, "0")} / ${COHORT_SIZE}`;
}
