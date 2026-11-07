"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** Minimal accessible modal: backdrop, Escape to close, focus moved inside, focus restored on close. */
export function Dialog({
  open, onClose, title, children, testId, tone,
}: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; testId?: string; tone?: "danger" }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = box.current?.querySelector<HTMLElement>("[data-autofocus], input, textarea, button");
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
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
        className={`fade-in relative w-full max-w-md rounded-md border bg-panel shadow-xl ${tone === "danger" ? "border-kill/50" : "border-line"}`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-panel-2 hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
