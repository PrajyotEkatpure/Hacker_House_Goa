"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a message stays up. Long enough to read, short enough to ignore. */
const TOAST_MS = 3000;

export interface ToastController {
  /** Current message, or null when nothing is showing. */
  toast: string | null;
  /** Show a message; re-showing restarts the timer instead of queueing. */
  show: (message: string) => void;
}

/**
 * Owns the toast message + its auto-dismiss timer.
 *
 * The timer lives in the hook rather than in <Toast> so that the component stays
 * a pure function of its props — the page can therefore render the toast anywhere
 * in the tree without the dismissal behaviour changing.
 */
export function useToast(): ToastController {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setToast(message);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setToast(null);
    }, TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return { toast, show };
}

export interface ToastProps {
  message: string | null;
}

export function Toast({ message }: ToastProps) {
  return (
    // The live region is ALWAYS mounted, even when empty. Screen readers only
    // announce changes inside a region that already existed — mounting the whole
    // element together with its text is the classic reason a toast is silent.
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4"
      // Sits above the fixed action bar (and above the home indicator on iOS).
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 5.75rem)" }}
    >
      {message === null ? null : (
        <p className="pointer-events-auto max-w-sm rounded-sm border-[3px] border-goa-ink bg-goa-yellow px-4 py-2 text-center font-data text-sm font-medium text-goa-ink shadow-[4px_4px_0_0_var(--color-goa-ink)]">
          {message}
        </p>
      )}
    </div>
  );
}

export default Toast;
