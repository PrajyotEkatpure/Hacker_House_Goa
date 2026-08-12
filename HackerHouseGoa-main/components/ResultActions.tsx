"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { canvasToPngBlob, designSizeFor, renderOgCanvas, renderToCanvas } from "@/lib/render";
import {
  buildCaption,
  canShareFiles,
  copyText,
  downloadBlob,
  filenameFor,
  shareFiles,
  siteUrl,
  uploadCard,
  xIntentUrl,
} from "@/lib/share";
import type { RenderFormat, RenderInput } from "@/lib/types";

export interface ResultActionsProps {
  format: RenderFormat;
  input: RenderInput;
  onToast: (message: string) => void;
}

type Busy = "post" | "share" | "download" | "copy" | null;

const PRIMARY =
  "flex min-h-[52px] w-full items-center justify-center rounded-sm border-[3px] border-goa-ink bg-goa-yellow px-4 font-display text-lg tracking-wide text-goa-ink shadow-[4px_4px_0_0_var(--color-goa-ink)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_0_var(--color-goa-ink)] disabled:opacity-60";
const SECONDARY =
  "flex min-h-[44px] w-full items-center justify-center rounded-sm border-2 border-goa-cream/70 px-3 font-data text-[12px] uppercase tracking-[0.14em] text-goa-cream disabled:opacity-50";

export default function ResultActions({ format, input, onToast }: ResultActionsProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [shareable, setShareable] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [caption, setCaption] = useState("");

  const design = designSizeFor(format);

  /**
   * One in-flight/settled render of the main PNG, shared by every button.
   *
   * Actions never rasterise on their own — they await this. That is what makes
   * "Share image" work on iOS: Safari gates `navigator.share` behind a transient
   * user activation that expires after a few seconds, so a button that had to
   * render 1080×1350 from scratch first would sometimes lose the gesture.
   */
  const mainRender = useRef<Promise<Blob> | null>(null);

  const ensureMain = useCallback((): Promise<Blob> => {
    const existing = mainRender.current;
    if (existing) return existing;
    const pending = (async () => {
      const canvas = await renderToCanvas(format, input);
      return canvasToPngBlob(canvas);
    })();
    mainRender.current = pending;
    // Never cache a rejection, or one transient failure breaks every later tap.
    pending.catch(() => {
      if (mainRender.current === pending) mainRender.current = null;
    });
    return pending;
  }, [format, input]);

  // Reset the cache and warm a fresh render whenever the graphic changes. This
  // is not blocking anything: no button waits on it, no spinner is shown; it
  // only fills in the long-press <img> below.
  useEffect(() => {
    mainRender.current = null;
    setObjectUrl(null);
    let cancelled = false;
    ensureMain()
      .then((blob) => {
        if (!cancelled) setObjectUrl(URL.createObjectURL(blob));
      })
      .catch(() => {
        // Silent: the buttons surface the failure when the user actually taps one.
      });
    return () => {
      cancelled = true;
    };
  }, [ensureMain]);

  // Revoke on replace and on unmount; a leaked blob URL pins the whole PNG in
  // memory for the life of the tab.
  useEffect(() => {
    if (!objectUrl) return;
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  useEffect(() => {
    // Runs in an effect so the server-rendered markup and the first client render
    // agree — probing navigator during render would hydrate-mismatch.
    const probe = new File([new Uint8Array([0])], "probe.png", { type: "image/png" });
    setShareable(canShareFiles([probe]));
    setIsIOS(/iP(hone|ad|od)/.test(navigator.userAgent));
    setCaption(buildCaption(input.fields.builderNo, siteUrl()));
  }, [input.fields.builderNo]);

  /* ------------------------------------------------------------- route 1 */
  const handlePost = useCallback(() => {
    const site = siteUrl();
    // No URL in the text: xIntentUrl passes one as `url`, and X appends that to
    // the tweet body. Including it here as well posted the link twice.
    const text = buildCaption(input.fields.builderNo, site, { includeUrl: false });

    // iOS/Safari popup blocker: window.open() is only honoured while the click's
    // user activation is alive, and any `await` before it loses that. So claim
    // the tab NOW, synchronously, and point it somewhere once the upload lands.
    const opened = window.open("", "_blank");
    if (opened) {
      try {
        // Sever the reverse reference; we still own `opened` to navigate it.
        opened.opener = null;
      } catch {
        // Some browsers make this read-only. Harmless either way.
      }
    }
    const go = (href: string) => {
      if (opened) opened.location.href = href;
      // Popup blocked entirely (no handle) — never dead-end, just use this tab.
      else window.location.href = href;
    };

    setBusy("post");
    void (async () => {
      try {
        const main = await ensureMain();
        const og = await canvasToPngBlob(await renderOgCanvas(format, input));
        const stored = await uploadCard(main, og);
        go(xIntentUrl(text, `${site}/c/${stored.id}`));
      } catch {
        // Blob storage is optional in this app; falling back to the bare site URL
        // still gets the user to a pre-filled post with #FrameInGoa in it.
        go(xIntentUrl(text, site));
        onToast("Couldn't upload the image — attach the PNG to your post manually");
      } finally {
        setBusy(null);
      }
    })();
  }, [ensureMain, format, input, onToast]);

  /* ------------------------------------------------------------- route 2 */
  const handleShare = useCallback(async () => {
    setBusy("share");
    try {
      const blob = await ensureMain();
      const file = new File([blob], filenameFor(format, input.fields.name), { type: "image/png" });
      const text = buildCaption(input.fields.builderNo, siteUrl());
      const shared = await shareFiles([file], text);
      if (shared) {
        // Most share sheets (X's included) drop the `text` when a file is attached,
        // so put the caption on the clipboard as the reliable path.
        await copyText(text);
        onToast("Caption copied — paste it in your post");
      }
    } catch {
      onToast("Sharing failed — use Download instead");
    } finally {
      setBusy(null);
    }
  }, [ensureMain, format, input, onToast]);

  /* ------------------------------------------------------------- route 3 */
  const handleDownload = useCallback(async () => {
    setBusy("download");
    try {
      const blob = await ensureMain();
      downloadBlob(blob, filenameFor(format, input.fields.name));
      onToast("PNG saved");
    } catch {
      onToast("Couldn't build the PNG — try again");
    } finally {
      setBusy(null);
    }
  }, [ensureMain, format, input, onToast]);

  const handleCopy = useCallback(async () => {
    setBusy("copy");
    const text = buildCaption(input.fields.builderNo, siteUrl());
    const ok = await copyText(text);
    onToast(ok ? "Caption copied" : "Copy blocked — select the caption below instead");
    setBusy(null);
  }, [input.fields.builderNo, onToast]);

  const alt = format === "pfp" ? "Your Hacker House Goa profile frame" : "Your Hacker House Goa Builder ID card";

  return (
    <div className="w-full">
      {/* Aspect reserved up front so nothing shifts when the PNG finishes. */}
      <div className="w-full" style={{ aspectRatio: `${design.width} / ${design.height}` }}>
        {objectUrl ? (
          // A real <img> (not the canvas) so iOS users can long-press → Save Image,
          // which is by far the most-used save route on an iPhone.
          <img
            src={objectUrl}
            alt={alt}
            className="h-full w-full rounded-md border-[3px] border-goa-cream object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded-md border-[3px] border-dashed border-goa-cream/40 font-data text-[11px] uppercase tracking-[0.2em] text-goa-cream/60">
            Rendering…
          </div>
        )}
      </div>

      {isIOS ? (
        <p className="mt-2 text-center font-data text-[11px] uppercase tracking-[0.14em] text-goa-yellow">
          Long-press the image to save it
        </p>
      ) : null}

      <details className="mt-3 rounded-sm border-2 border-goa-cream/30 px-3 py-2">
        <summary className="cursor-pointer font-data text-[11px] uppercase tracking-[0.18em] text-goa-cream/70">
          Caption
        </summary>
        <p className="mt-2 font-data text-xs leading-relaxed break-words text-goa-cream/85 select-all">
          {caption}
        </p>
      </details>

      {/* Sticky rather than fixed: it pins the primary action to the bottom of the
          viewport while the graphic scrolls, and stops being sticky once the page
          bottom is reached — no bar floating over the footer on desktop. */}
      <div
        className="sticky bottom-0 z-20 mt-4 -mx-4 border-t-[3px] border-goa-red bg-goa-green-deep/95 px-4 pt-3 backdrop-blur"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
      >
        <button type="button" onClick={handlePost} disabled={busy !== null} className={PRIMARY}>
          {busy === "post" ? "Opening X…" : "Post on X ↗"}
        </button>

        <div className="mt-2 grid grid-cols-2 gap-2">
          {shareable ? (
            <button
              type="button"
              onClick={() => void handleShare()}
              disabled={busy !== null}
              className={SECONDARY}
            >
              {busy === "share" ? "Sharing…" : "Share image"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={busy !== null}
            className={SECONDARY}
          >
            {busy === "download" ? "Saving…" : "Download PNG"}
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={busy !== null}
            className={shareable ? `${SECONDARY} col-span-2` : SECONDARY}
          >
            {busy === "copy" ? "Copying…" : "Copy caption"}
          </button>
        </div>
      </div>
    </div>
  );
}
