"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** Minimal accessible modal: backdrop, Escape to close, focus moved inside, focus restored on close. */
export function Dialog({
  open, onClose, title, children, testId, tone,
}: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; testId?: string; tone?: "danger" }) {
  const box = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without re-running the focus effect: parents re-render on every
  // desk poll, and re-running it bounced focus out of the dialog while the user was typing.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = box.current?.querySelector<HTMLElement>("[data-autofocus], input, textarea, button");
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        data-testid={testId}
        className={`fade-in relative w-full max-w-md rounded-[24px] bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.25)] ${tone === "danger" ? "ring-2 ring-kill/40" : ""}`}
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-ink-3 hover:bg-panel-2 hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 pb-5 pt-2">{children}</div>
      </div>
    </div>
  );
}
