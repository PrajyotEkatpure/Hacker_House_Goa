"use client";

import { useCallback, useId, useRef, useState } from "react";


export interface UploaderProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

/**
 * The one and only entry point to the tool: a big tappable drop zone wrapping a
 * hidden file input.
 *
 * Deliberately NOT using `capture`: on Android and iOS that attribute forces the
 * camera and removes the "choose from library" option entirely, which is where
 * everyone's photo actually lives.
 */
export default function Uploader({ onFile, disabled = false }: UploaderProps) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  // Nested dragenter/dragleave pairs fire for every child element, so a boolean
  // alone flickers. Count enters and leaves instead.
  const dragDepth = useRef(0);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset before dispatching: without this, picking the SAME file twice in a
      // row is a no-op because `change` never fires when the value is unchanged.
      event.target.value = "";
      if (file) onFile(file);
    },
    [onFile],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (disabled) return;
      const file = event.dataTransfer.files.item(0);
      if (file) onFile(file);
    },
    [disabled, onFile],
  );

  const base =
    "tappable relative flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-md border-[3px] border-dashed px-6 py-10 text-center transition-colors";
  const tone = disabled
    ? "cursor-not-allowed border-goa-cream/30 bg-goa-green-deep/60 text-goa-cream/50"
    : dragging
      ? "border-goa-yellow bg-goa-green-light/40 text-goa-cream"
      : "border-goa-cream/60 bg-goa-green-deep text-goa-cream hover:border-goa-yellow";

  return (
    <div className="w-full">
      <label
        htmlFor={inputId}
        className={`${base} ${tone}`}
        onDragOver={(event) => {
          // Without preventDefault the browser navigates to the dropped file.
          event.preventDefault();
          if (!disabled) event.dataTransfer.dropEffect = "copy";
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <span
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-full border-[3px] border-goa-yellow bg-goa-green text-2xl"
        >
          🌴
        </span>
        <span className="font-display text-2xl leading-tight text-goa-cream">Drop your photo</span>
        <span className="font-data text-[11px] uppercase tracking-[0.2em] text-goa-cream/70">
          tap to choose · jpg · png · heic
        </span>
        <span className="font-data text-[11px] text-goa-cream/55">
          Stays on your phone — nothing is uploaded until you tap share.
        </span>
        <input
          id={inputId}
          type="file"
          // .heic/.heif spelled out because some Android pickers ignore image/*
          // for HEIC and would grey the file out.
          accept="image/*,.heic,.heif"
          className="sr-only absolute h-px w-px opacity-0"
          disabled={disabled}
          onChange={handleChange}
        />
      </label>
    </div>
  );
}
