"use client";

import { OctagonX, Play, Power } from "lucide-react";
import { useCallback, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button, cn } from "@/components/ui/kit";
import { errorMessage } from "@/lib/api";
import { useDesk } from "@/lib/desk-context";

/** Confirm dialog shared by the header button and the big switch on /risk. */
function ControlDialog({ mode, open, onClose }: { mode: "kill" | "resume"; open: boolean; onClose: () => void }) {
  const { kill, resume } = useDesk();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isKill = mode === "kill";

  const close = useCallback(() => {
    setReason("");
    setErr(null);
    onClose();
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = reason.trim() || (isKill ? "manual kill switch (dashboard)" : "manual resume (dashboard)");
      await (isKill ? kill(r) : resume(r));
      close();
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      tone={isKill ? "danger" : undefined}
      testId={isKill ? "kill-dialog" : "resume-dialog"}
      title={isKill ? "Halt all paper trading?" : "Resume paper trading?"}
    >
      <form onSubmit={submit} className="space-y-3">
        <p className="text-[13px] leading-relaxed text-ink-2">
          {isKill
            ? "Every new paper order fails the first risk check (not_halted) from this moment. Market data keeps recording and the models keep running. The action goes into the control log at the current event time, so any replay reproduces it."
            : "New signals will be allowed to pass the risk checks again. The resume is written to the event log."}
        </p>
        <label className="block">
          <span className="label">Reason (logged)</span>
          <input
            data-testid={isKill ? "kill-reason" : "resume-reason"}
            data-autofocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={isKill ? "e.g. Polymarket feed looks stale" : "e.g. feed recovered"}
            className="mt-1 h-10 w-full rounded-full border border-transparent bg-panel-2 px-4 text-[13px] outline-none focus:border-ink-3"
          />
        </label>
        {err ? <p className="text-[12.5px] text-neg">{err}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant={isKill ? "danger" : "primary"}
            loading={busy}
            data-testid={isKill ? "kill-confirm" : "resume-confirm"}
          >
            {isKill ? <OctagonX className="size-4" /> : <Play className="size-4" />}
            {isKill ? "Halt trading" : "Resume trading"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Compact kill switch in the header of every page. */
export function HeaderKillSwitch() {
  const { halted } = useDesk();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={halted ? "resume-header" : "kill-switch-header"}
        onClick={() => setOpen(true)}
        title={halted ? "Trading halted: resume" : "Kill switch: halt all paper trading"}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors sm:px-3",
          halted
            ? "bg-pos-soft text-pos hover:opacity-90"
            : "bg-panel text-kill hover:bg-kill hover:text-white",
        )}
      >
        {halted ? <Play className="size-3.5" /> : <Power className="size-3.5" strokeWidth={2.5} />}
        <span className="hidden sm:inline">{halted ? "Resume" : "Kill"}</span>
      </button>
      <ControlDialog mode={halted ? "resume" : "kill"} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The big switch on /risk. */
export function BigKillSwitch() {
  const { halted, haltReason } = useDesk();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
      {halted ? (
        <button
          type="button"
          data-testid="resume-button"
          onClick={() => setOpen(true)}
          className="group flex size-36 shrink-0 flex-col items-center justify-center rounded-full bg-pos-soft text-pos transition-transform hover:scale-[1.02]"
        >
          <Play className="size-9" strokeWidth={2.2} />
          <span className="mt-1 text-[12px] font-bold uppercase tracking-[0.12em]">Resume</span>
        </button>
      ) : (
        <button
          type="button"
          data-testid="kill-switch"
          onClick={() => setOpen(true)}
          className="group flex size-36 shrink-0 flex-col items-center justify-center rounded-full bg-chip text-chip-ink shadow-[0_0_0_8px_var(--panel-2)] transition-transform hover:scale-[1.02]"
        >
          <Power className="size-10 text-kill" strokeWidth={2.4} />
          <span className="mt-1 text-[12px] font-bold uppercase tracking-[0.14em]">Kill switch</span>
        </button>
      )}
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn("inline-block size-2.5 rounded-full", halted ? "bg-kill" : "bg-pos live-dot")} />
          <span data-testid="trading-state" className="text-[15px] font-semibold">
            {halted ? "Trading halted" : "Trading enabled (paper)"}
          </span>
        </div>
        <p className="max-w-md text-[12.5px] leading-relaxed text-ink-2">
          {halted
            ? <>Reason: <span className="text-ink">{haltReason || "not given"}</span>. No new paper orders are sent until you resume. Market data and models keep running.</>
            : "One press halts every new paper order at the risk layer: the first check, not_halted, fails. It asks for a reason, which is written to the control log, so replays reproduce the halt."}
        </p>
      </div>
      <ControlDialog mode={halted ? "resume" : "kill"} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
