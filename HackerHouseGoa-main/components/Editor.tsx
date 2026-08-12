"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { designSizeFor, drawFormat, photoRegionFor } from "@/lib/render";
import { MAX_SCALE, MIN_SCALE, panBy, zoomTo } from "@/lib/transform";
import { IDENTITY_TRANSFORM } from "@/lib/types";
import type { CardFields, RenderFormat, SourceImage, Transform } from "@/lib/types";

export interface EditorProps {
  format: RenderFormat;
  source: SourceImage;
  fields: CardFields;
  transform: Transform;
  onTransformChange: (next: Transform) => void;
}

/**
 * A retina canvas costs width × height × dpr² bytes. At dpr 3 (Pixel, iPhone Pro)
 * a full-width card preview is ~2.2× the pixels of dpr 2 for no visible gain on a
 * photo, and it is the single biggest cause of a janky drag on mid-range Android.
 */
const MAX_DPR = 2;

export default function Editor({ format, source, fields, transform, onTransformChange }: EditorProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cssWidth, setCssWidth] = useState(0);

  const design = useMemo(() => designSizeFor(format), [format]);
  const region = useMemo(() => photoRegionFor(format), [format]);

  /* ------------------------------------------------------------ live refs --
     Pointer handlers are registered once but need the *current* transform and
     preview scale. Reading them from props inside the handler would capture the
     values from the render the handler was created in. */
  const transformRef = useRef<Transform>(transform);
  const onChangeRef = useRef(onTransformChange);
  const previewScaleRef = useRef(1);

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);
  useEffect(() => {
    onChangeRef.current = onTransformChange;
  }, [onTransformChange]);
  useEffect(() => {
    previewScaleRef.current = cssWidth > 0 ? cssWidth / design.width : 1;
  }, [cssWidth, design.width]);

  /**
   * Commit a new transform. The ref is updated *synchronously* so that a burst
   * of pointermove events inside one frame each build on the previous one; React
   * state alone would lag a tick behind and the drag would feel rubbery.
   */
  const apply = useCallback((next: Transform) => {
    transformRef.current = next;
    onChangeRef.current(next);
  }, []);

  /* ------------------------------------------------------------- measuring */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const update = (width: number) => {
      // Sub-pixel resize noise would otherwise re-run the (async) draw forever.
      setCssWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
    };
    update(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* -------------------------------------------------------------- drawing --
     `drawFormat` is async (fonts, brand SVGs), so two draws can be in flight at
     once and would interleave their ctx state on the same canvas. Serialise them
     through a promise chain and drop any queued draw that a newer one supersedes. */
  const drawSeq = useRef(0);
  const drawChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cssWidth <= 0) return;

    const dpr = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, MAX_DPR);
    const previewScale = cssWidth / design.width;
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(((cssWidth * design.height) / design.width) * dpr));

    // Assigning width/height also clears the canvas, so only do it on a real change.
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const seq = drawSeq.current + 1;
    drawSeq.current = seq;

    drawChain.current = drawChain.current.then(async () => {
      if (drawSeq.current !== seq) return; // superseded while queued
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // One code path for preview and export: the compositor always draws in
        // design space (1080-wide) and we scale the whole context down instead.
        ctx.scale(previewScale * dpr, previewScale * dpr);
        await drawFormat(ctx, format, { source, transform, fields });
      } catch {
        // A failed draw must not poison the chain — the next redraw still runs.
      }
    });
  }, [cssWidth, design.height, design.width, fields, format, source, transform]);

  /* ------------------------------------------------------------- gestures --
     Pointer Events unify mouse/touch/pen. Pointer capture means a drag that
     leaves the canvas keeps delivering moves to us. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ startDistance: number; startTransform: Transform } | null>(null);
  const panAnchor = useRef<{ x: number; y: number } | null>(null);

  const twoPointerDistance = (): number | null => {
    const points = Array.from(pointers.current.values());
    const a = points[0];
    const b = points[1];
    if (!a || !b) return null;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2) {
      const distance = twoPointerDistance();
      // A zero distance would divide by zero on the first move.
      pinch.current = {
        startDistance: distance && distance > 0 ? distance : 1,
        startTransform: transformRef.current,
      };
      // Panning at the same time as a pinch reads as jitter: the midpoint of two
      // fingers moves constantly even when the user thinks they are only zooming.
      panAnchor.current = null;
    } else {
      panAnchor.current = { x: event.clientX, y: event.clientY };
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const tracked = pointers.current.get(event.pointerId);
    if (!tracked) return; // a pointer that started outside the surface
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    if (pointers.current.size >= 2) {
      const active = pinch.current;
      const distance = twoPointerDistance();
      if (!active || distance === null) return;
      // Always scale from the transform captured at gesture start, so the zoom
      // tracks the fingers exactly instead of compounding rounding each frame.
      apply(
        zoomTo(
          region,
          source,
          active.startTransform,
          active.startTransform.scale * (distance / active.startDistance),
        ),
      );
      return;
    }

    const anchor = panAnchor.current;
    if (!anchor) return;
    const dx = event.clientX - anchor.x;
    const dy = event.clientY - anchor.y;
    if (dx === 0 && dy === 0) return;
    anchor.x = event.clientX;
    anchor.y = event.clientY;
    apply(panBy(region, source, transformRef.current, dx, dy, previewScaleRef.current));
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointers.current.delete(event.pointerId);

    if (pointers.current.size < 2) pinch.current = null;

    const remaining = Array.from(pointers.current.values())[0];
    // Lifting one finger of a pinch: re-anchor on the finger still down, or the
    // photo would jump by the full distance between the two on the next move.
    panAnchor.current = pointers.current.size === 1 && remaining ? { x: remaining.x, y: remaining.y } : null;
  };

  /* wheel = zoom on desktop. Registered manually because React's onWheel is
     passive, and a passive listener cannot preventDefault the page scroll. */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // deltaMode 1 = lines, 2 = pages (Firefox / some mice). Normalise to px or
      // a line-scrolling mouse would zoom imperceptibly.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const factor = Math.exp((-event.deltaY * unit) / 420);
      const current = transformRef.current;
      apply(zoomTo(region, source, current, current.scale * factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, region, source]);

  const zoomPercent = Math.round(transform.scale * 100);

  return (
    <div className="w-full">
      <div
        ref={surfaceRef}
        className="editor-surface relative w-full overflow-hidden rounded-md border-[3px] border-goa-cream bg-goa-green-deep shadow-[5px_5px_0_0_var(--color-goa-green-deep)]"
        style={{ aspectRatio: `${design.width} / ${design.height}` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        // No onPointerLeave: pointer capture already guarantees a pointerup even
        // when the finger travels off the canvas, and ending the drag on leave
        // would abort perfectly normal drags that overshoot the edge.
        onPointerCancel={handlePointerEnd}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Live preview of your graphic"
          className="block h-full w-full"
        />
      </div>

      <p className="mt-2 text-center font-data text-[11px] uppercase tracking-[0.16em] text-goa-cream/65">
        Drag to reposition · pinch to zoom
      </p>

      <div className="mt-2 flex items-center gap-3">
        <label htmlFor="zoom-range" className="sr-only">
          Zoom
        </label>
        <span aria-hidden="true" className="font-data text-xs text-goa-cream/70">
          −
        </span>
        <input
          id="zoom-range"
          type="range"
          min={MIN_SCALE}
          max={MAX_SCALE}
          step={0.01}
          value={transform.scale}
          onChange={(event) => apply(zoomTo(region, source, transformRef.current, Number(event.target.value)))}
          className="h-11 min-w-0 flex-1 accent-[var(--color-goa-yellow)]"
          aria-valuetext={`${zoomPercent} percent`}
        />
        <span aria-hidden="true" className="font-data text-xs text-goa-cream/70">
          +
        </span>
        <button
          type="button"
          onClick={() => apply(IDENTITY_TRANSFORM)}
          className="h-11 shrink-0 rounded-sm border-2 border-goa-cream/70 px-3 font-data text-[11px] uppercase tracking-[0.14em] text-goa-cream"
        >
          Recenter
        </button>
      </div>
    </div>
  );
}
