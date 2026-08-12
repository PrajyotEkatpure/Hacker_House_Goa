"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import CardForm from "@/components/CardForm";
import Editor from "@/components/Editor";
import ResultActions from "@/components/ResultActions";
import { Toast, useToast } from "@/components/Toast";
import Uploader from "@/components/Uploader";
import { BRAND_ASSETS, EVENT } from "@/lib/brand";
import { ensureFontsReady } from "@/lib/fonts";
import { ImageLoadError, loadImageFile } from "@/lib/image";
import type { LoadStage } from "@/lib/image";
import { designSizeFor, photoRegionFor } from "@/lib/render";
import { fetchBuilderNumber } from "@/lib/share";
import { fallbackBuilderNumber, rerollFrom, titleFor } from "@/lib/titles";
import { clampTransform } from "@/lib/transform";
import { IDENTITY_TRANSFORM } from "@/lib/types";
import type { CardFields, RenderFormat, RenderInput, SourceImage, Transform } from "@/lib/types";

type Phase = "idle" | "loading" | "editing" | "result";

/**
 * Builder ID leads. It is the primary deliverable and the only format with a
 * form behind it — landing on the PFP frame instead hid every field (role,
 * college, phone) behind a tab people did not know to press, and they concluded
 * the fields simply did not exist.
 */
const FORMATS: ReadonlyArray<{ id: RenderFormat; label: string; size: string }> = [
  { id: "card", label: "Builder ID", size: "1080 × 1350" },
  { id: "pfp", label: "PFP Frame", size: "1080 × 1080" },
];

const PRIMARY_BUTTON =
  "flex min-h-[52px] flex-1 items-center justify-center rounded-sm border-[3px] border-goa-ink bg-goa-yellow px-4 font-display text-lg tracking-wide text-goa-ink shadow-[4px_4px_0_0_var(--color-goa-ink)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_0_var(--color-goa-ink)] disabled:opacity-60 disabled:shadow-none";
const GHOST_BUTTON =
  "flex min-h-[44px] items-center justify-center rounded-sm border-2 border-goa-cream/70 px-4 font-data text-[12px] uppercase tracking-[0.14em] text-goa-cream";

export default function Page() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [format, setFormat] = useState<RenderFormat>("card");
  const [source, setSource] = useState<SourceImage | null>(null);
  const [loadStage, setLoadStage] = useState<LoadStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY_TRANSFORM);

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [college, setCollege] = useState("");
  /** Held in full for the form; only `maskPhone` output ever reaches the canvas. */
  const [phone, setPhone] = useState("");
  /** 0 until the user rolls the dice; a new name resets it (see `applyName`). */
  const [salt, setSalt] = useState(0);
  const [serverBuilderNo, setServerBuilderNo] = useState<number | null>(null);

  const { toast, show } = useToast();

  // Register the canvas webfonts as early as possible. Canvas does not wait for
  // fonts, so warming them during the upload hides the load behind the decode.
  useEffect(() => {
    void ensureFontsReady();
  }, []);

  /* ------------------------------------------------------------ derived state */

  const title = useMemo(() => titleFor(name, salt), [name, salt]);
  // The live counter is a global INCR, so it is fetched once and then frozen —
  // the badge number must not shuffle while the user is still typing their name.
  const builderNo = serverBuilderNo ?? fallbackBuilderNumber(name);

  const fields = useMemo<CardFields>(
    () => ({ name, role, college, phone, title, builderNo }),
    [name, role, college, phone, title, builderNo],
  );

  const renderInput = useMemo<RenderInput | null>(
    () => (source ? { source, transform, fields } : null),
    [source, transform, fields],
  );

  const design = designSizeFor(format);
  // The PFP prints no text at all, so a name is optional there; the ID card
  // would render an empty headline without one.
  const canProceed = format === "pfp" || name.trim().length > 0;

  /* ----------------------------------------------------------------- upload */

  /**
   * The decoded bitmap currently on screen, mirrored out of state so it can be
   * *closed* when it is replaced.
   *
   * An ImageBitmap holds its pixels off-heap and nothing reclaims them on GC
   * timing you can rely on. At LIMITS.maxSourceEdge that is 2400×2400×4 ≈ 23MB
   * apiece, and both "Try another photo" and "New photo" invite the user to do
   * this repeatedly — four attempts leaks ~92MB, which is the exact mid-range
   * Android tab-kill that lib/image.ts closes its own intermediates to avoid.
   */
  const liveSource = useRef<SourceImage | null>(null);

  const replaceSource = useCallback((next: SourceImage | null) => {
    const previous = liveSource.current;
    liveSource.current = next;
    setSource(next);
    if (previous && previous !== next) {
      // Deferred a turn: <Editor>'s serialised draw chain (and a warm render in
      // <ResultActions>) can still be holding the outgoing bitmap, and drawImage
      // on a closed one throws. Both wrap their draws in try/catch, so the worst
      // case is one dropped frame of a preview that is being torn down anyway.
      setTimeout(() => previous.bitmap.close(), 0);
    }
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setPhase("loading");
      setLoadStage("decoding");
      try {
        const image = await loadImageFile(file, (stage) => setLoadStage(stage));
        replaceSource(image);
        setTransform(IDENTITY_TRANSFORM);
        setPhase("editing");
      } catch (caught) {
        replaceSource(null);
        setPhase("idle");
        setError(
          caught instanceof ImageLoadError
            ? caught.message
            : "That photo could not be read. A JPG or PNG works best.",
        );
      } finally {
        setLoadStage(null);
      }
    },
    [replaceSource],
  );

  /* -------------------------------------------------------- builder number --
     Fired exactly once, on the first successful upload. `fetchBuilderNumber`
     never throws and never blocks: the fallback number is already on screen, so
     a sleeping serverless counter costs the user nothing. */
  const counterStarted = useRef(false);
  const latestName = useRef("");

  // Declared before the fetch effect so it has already run when that one fires.
  useEffect(() => {
    latestName.current = name;
  }, [name]);

  useEffect(() => {
    if (!source || counterStarted.current) return;
    counterStarted.current = true;
    // NO per-effect `cancelled` flag here, deliberately. next.config.ts turns on
    // reactStrictMode, so in `npm run dev` — the only command the README gives —
    // React mounts, unmounts and remounts this effect. A cancelled-closure guard
    // would flip on the first cleanup while `counterStarted` made the second run
    // a no-op, so the resolved number was discarded and the live counter was
    // permanently dead in dev. The ref alone is already the once-only guard, and
    // `fetchBuilderNumber` never throws, so there is nothing else to cancel;
    // setting state after an unmount is a silent no-op in React 18+.
    void fetchBuilderNumber(latestName.current).then((value) => {
      setServerBuilderNo(value);
    });
  }, [source]);

  /* ------------------------------------------------------------- interactions */

  const switchFormat = useCallback(
    (next: RenderFormat) => {
      if (next === format) return;
      if (source) {
        // The square PFP disc and the 4:5 card window have different aspects, so
        // an offset that was legal in one can expose a photo edge in the other.
        // Re-clamp instead of carrying the raw values across.
        setTransform((current) => clampTransform(photoRegionFor(next), source, current));
      }
      setFormat(next);
    },
    [format, source],
  );

  const applyName = useCallback((next: string) => {
    // A different name earns a fresh title; only an explicit reroll sticks.
    setSalt(0);
    setName(next);
  }, []);

  const handleFieldsChange = useCallback(
    (next: CardFields) => {
      if (next.name !== name) applyName(next.name);
      setRole(next.role);
      setCollege(next.college);
      setPhone(next.phone);
    },
    [applyName, name],
  );

  const handleReroll = useCallback(() => {
    setSalt(rerollFrom(name, salt).salt);
  }, [name, salt]);

  const startOver = useCallback(() => {
    replaceSource(null);
    setError(null);
    setTransform(IDENTITY_TRANSFORM);
    setPhase("idle");
  }, [replaceSource]);

  /* ---------------------------------------------------------------- render */

  const showBottomBar = phase === "editing";

  return (
    <div className="min-h-[100dvh] w-full overflow-x-hidden">
      <main
        className="mx-auto flex w-full max-w-md flex-col px-4"
        style={{
          paddingBottom: showBottomBar ? "calc(env(safe-area-inset-bottom) + 7.5rem)" : "2.5rem",
        }}
      >
        {/* ------------------------------------------------------------ header */}
        <header className="relative mt-4 overflow-hidden rounded-md border-[3px] border-goa-red bg-goa-green-deep p-3">
          <img
            src={BRAND_ASSETS.sun}
            alt=""
            aria-hidden="true"
            width={64}
            height={64}
            className="pointer-events-none absolute -top-3 -right-2 h-16 w-16 opacity-25"
          />
          <div className="relative flex items-center gap-3">
            <img
              src={BRAND_ASSETS.logo}
              alt={EVENT.wordmark}
              width={240}
              height={64}
              className="h-9 w-auto shrink-0"
            />
            <div className="min-w-0">
              <p className="font-data text-[9px] uppercase tracking-[0.24em] text-goa-yellow">{EVENT.studio}</p>
              <h1 className="font-display text-2xl leading-none text-goa-cream">FrameInGoa</h1>
            </div>
          </div>
          <p className="relative mt-2 border-t border-dashed border-goa-cream/25 pt-2 font-data text-[9px] uppercase tracking-[0.18em] text-goa-cream/70">
            {EVENT.dates} · {EVENT.tagline}
          </p>
        </header>

        {/* -------------------------------------------------- format selector */}
        <div
          role="group"
          aria-label="Choose a graphic"
          className="mt-4 grid grid-cols-2 gap-1 rounded-md border-[3px] border-goa-cream bg-goa-cream p-1"
        >
          {FORMATS.map((option) => {
            const active = option.id === format;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => switchFormat(option.id)}
                className={
                  active
                    ? "min-h-[52px] rounded-sm bg-goa-red px-2 py-2 text-goa-cream"
                    : "min-h-[52px] rounded-sm px-2 py-2 text-goa-ink"
                }
              >
                <span className="block font-display text-base leading-tight">{option.label}</span>
                <span className="block font-data text-[9px] tracking-[0.16em] opacity-70">{option.size}</span>
              </button>
            );
          })}
        </div>

        {/* ------------------------------------------------------------- idle */}
        {phase === "idle" ? (
          <div className="mt-4">
            {error ? (
              <div
                role="alert"
                className="mb-3 rounded-md border-[3px] border-goa-red bg-goa-red/15 p-3"
              >
                <p className="font-data text-sm leading-snug text-goa-red">{error}</p>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="mt-2 min-h-[44px] rounded-sm border-2 border-goa-red px-3 font-data text-[11px] uppercase tracking-[0.16em] text-goa-red"
                >
                  Try another photo
                </button>
              </div>
            ) : null}

            <Uploader onFile={(file) => void handleFile(file)} />

            <div
              aria-hidden="true"
              className="my-4 h-4 w-full opacity-50"
              style={{
                backgroundImage: `url(${BRAND_ASSETS.wave})`,
                backgroundRepeat: "repeat-x",
                backgroundSize: "auto 100%",
              }}
            />

            <ol className="grid gap-2">
              {[
                "Pick a photo — it never leaves your phone",
                "Drag & pinch to frame it",
                `Download or post with ${EVENT.hashtag}`,
              ].map((step, index) => (
                <li key={step} className="flex items-start gap-3">
                  <span className="mt-[2px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-goa-yellow font-data text-[11px] text-goa-yellow">
                    {index + 1}
                  </span>
                  <span className="font-data text-sm leading-snug text-goa-cream/80">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {/* ---------------------------------------------------------- loading */}
        {phase === "loading" ? (
          <div className="mt-4 w-full" style={{ aspectRatio: `${design.width} / ${design.height}` }}>
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-md border-[3px] border-dashed border-goa-cream/45 bg-goa-green-deep p-6 text-center">
              <span
                aria-hidden="true"
                className="h-8 w-8 animate-spin rounded-full border-[3px] border-goa-yellow border-t-transparent"
              />
              <p className="font-data text-[11px] uppercase tracking-[0.2em] text-goa-cream/85">
                {loadStage === "converting"
                  ? "Converting iPhone photo…"
                  : loadStage === "downscaling"
                    ? "Resizing…"
                    : "Reading your photo…"}
              </p>
              {/* Shown ONLY while the HEIC decoder is running — it is the one step
                  slow enough to need explaining. */}
              {loadStage === "converting" ? (
                <p className="font-data text-[11px] leading-snug text-goa-cream/60">
                  HEIC takes a couple of seconds the first time. Nothing is uploaded.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ---------------------------------------------------------- editing */}
        {phase === "editing" && source && renderInput ? (
          <div className="mt-4">
            {format === "pfp" ? (
              <div className="mb-4 rounded-md border-[3px] border-goa-cream bg-goa-cream p-3 text-goa-ink">
                <label
                  htmlFor="pfp-name"
                  className="block font-data text-[10px] uppercase tracking-[0.24em] text-goa-red"
                >
                  Your name
                </label>
                <input
                  id="pfp-name"
                  type="text"
                  value={name}
                  maxLength={28}
                  autoCapitalize="words"
                  autoComplete="name"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Ada Lovelace"
                  onChange={(event) => applyName(event.target.value)}
                  className="mt-1 w-full rounded-sm border-2 border-goa-ink/25 bg-white px-3 py-2 font-display text-lg text-goa-ink placeholder:text-goa-ink/35 focus:border-goa-red"
                />
                <p className="mt-1 font-data text-[10px] leading-snug text-goa-ink/55">
                  Used for the file name and your caption — the frame itself stays text-free.
                </p>
                {/* Without this, the PFP tab looks like the app simply forgot to ask
                    for role / college / phone. Say where they went, and make it a
                    button rather than an instruction to go hunting. */}
                <button
                  type="button"
                  onClick={() => setFormat("card")}
                  className="mt-3 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-sm border-2 border-dashed border-goa-red/60 px-3 text-left"
                >
                  <span className="font-data text-[10px] leading-snug text-goa-ink/70">
                    Need role, college &amp; phone on it?
                  </span>
                  <span className="shrink-0 font-data text-[10px] font-bold uppercase tracking-[0.14em] text-goa-red">
                    Builder ID →
                  </span>
                </button>
              </div>
            ) : null}

            <Editor
              format={format}
              source={source}
              fields={fields}
              transform={transform}
              onTransformChange={setTransform}
            />

            {format === "card" ? (
              <CardForm fields={fields} onChange={handleFieldsChange} onReroll={handleReroll} />
            ) : null}
          </div>
        ) : null}

        {/* ----------------------------------------------------------- result */}
        {phase === "result" && renderInput ? (
          <div className="mt-4">
            <div className="mb-3 flex items-center gap-2">
              <button type="button" onClick={() => setPhase("editing")} className={GHOST_BUTTON}>
                ← Adjust
              </button>
              <button type="button" onClick={startOver} className={GHOST_BUTTON}>
                New photo
              </button>
            </div>
            <ResultActions format={format} input={renderInput} onToast={show} />
          </div>
        ) : null}

        <footer className="mt-8 border-t-2 border-dashed border-goa-cream/20 pt-3 pb-2">
          <p className="font-data text-[10px] uppercase tracking-[0.2em] text-goa-cream/55">
            {EVENT.wordmark} · {EVENT.motto}
          </p>
          <p className="mt-1 font-data text-[10px] uppercase tracking-[0.2em] text-goa-yellow">
            {EVENT.hashtag}
          </p>
        </footer>
      </main>

      {/* ------------------------------------------------- fixed action bar --
          The primary action lives in the thumb zone on a phone; in the result
          phase ResultActions supplies its own sticky bar instead. */}
      {showBottomBar ? (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t-[3px] border-goa-red bg-goa-green-deep/95 backdrop-blur"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
        >
          <div className="mx-auto w-full max-w-md px-4 pt-3">
            {canProceed ? null : (
              <p className="mb-2 font-data text-[11px] uppercase tracking-[0.14em] text-goa-yellow">
                Add your name to continue
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={startOver}
                aria-label="Start over with a different photo"
                title="Start over"
                className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-sm border-2 border-goa-cream/70 text-lg text-goa-cream"
              >
                <span aria-hidden="true">↺</span>
              </button>
              <button
                type="button"
                onClick={() => setPhase("result")}
                disabled={!canProceed}
                className={PRIMARY_BUTTON}
              >
                {format === "pfp" ? "Make my frame →" : "Make my ID →"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Toast message={toast} />
    </div>
  );
}
