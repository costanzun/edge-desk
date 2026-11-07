"use client";

import { ArrowRight, BookOpen, ChartSpline, ClipboardCheck, Store, X } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";

const KEY = "edgedesk.explainer.dismissed";
const EVT = "edgedesk-explainer";

function read(): "yes" | "no" {
  try {
    return window.localStorage.getItem(KEY) === "1" ? "yes" : "no";
  } catch {
    return "no";
  }
}
function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVT, cb);
  };
}
function setDismissed(v: boolean) {
  try {
    if (v) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {}
  window.dispatchEvent(new Event(EVT));
}

const STEPS = [
  {
    icon: Store,
    title: "Prediction markets",
    body: (
      <>
        Kalshi and Polymarket sell contracts like <q>Will Bitcoin be above $76,000 at 22:00 UTC?</q> A contract pays $1 if yes. Its price, 0 to 100¢, is the crowd&rsquo;s probability.
      </>
    ),
    chip: <><span className="num">44¢</span>&nbsp;on Kalshi ≈ 44% chance</>,
  },
  {
    icon: ChartSpline,
    title: "The options market",
    body: <>Bitcoin options on Deribit imply their own probability for the same question. Edge Desk turns the options prices into a probability for every strike.</>,
    chip: <>Options imply&nbsp;<span className="num">41%</span></>,
  },
  {
    icon: ClipboardCheck,
    title: "A paper trade, fully recorded",
    body: (
      <>
        When the two disagree by more than fees and model error, Edge Desk places a <strong className="font-medium text-ink">paper</strong> trade. It records every message and decision, so the day can be replayed and audited.
      </>
    ),
    chip: <>gap&nbsp;<span className="num">3¢</span>&nbsp;− fee − error → trade or skip</>,
  },
];

/** Plain-English "what is this" card at the top of the Desk; dismissible, remembered per browser. */
export function Explainer() {
  const dismissed = useSyncExternalStore(subscribe, read, () => "unknown" as const);
  if (dismissed === "unknown") return null;
  if (dismissed === "yes") {
    return (
      <button
        type="button"
        data-testid="explainer-show"
        onClick={() => setDismissed(false)}
        className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-brand"
      >
        <BookOpen className="size-3.5" /> What is this?
      </button>
    );
  }
  return (
    <section
      data-testid="explainer"
      aria-label="What Edge Desk does"
      className="relative overflow-hidden rounded-[24px] bg-panel p-5 sm:p-6"
    >
      <button
        type="button"
        data-testid="explainer-dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Hide this explanation"
        className="absolute right-4 top-4 rounded-full p-1.5 text-ink-3 hover:bg-panel-2 hover:text-ink"
      >
        <X className="size-4" />
      </button>
      <h2 className="pr-8 text-[11.5px] font-semibold uppercase tracking-[0.09em]">What Edge Desk does, in three steps</h2>
      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative flex flex-col rounded-[20px] bg-panel-2 p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-panel text-ink">
                <s.icon className="size-4" strokeWidth={1.7} />
              </span>
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">Step {i + 1}</span>
            </div>
            <h3 className="mt-2.5 text-[15px] font-medium">{s.title}</h3>
            <p className="mt-1 flex-1 text-[13px] leading-relaxed text-ink-2">{s.body}</p>
            <div className="mt-3 inline-flex w-fit items-center rounded-full bg-panel px-3 py-1 text-[11.5px] text-ink-2">{s.chip}</div>
            {i < STEPS.length - 1 ? (
              <ArrowRight aria-hidden className="absolute -right-3 top-1/2 z-10 hidden size-5 -translate-y-1/2 rounded-full bg-panel p-0.5 text-ink-3 md:block" />
            ) : null}
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p data-testid="explainer-finding" className="max-w-3xl text-[13px] leading-relaxed text-ink-2">
          <span className="font-semibold text-ink">Honest finding so far:</span> Kalshi is usually right. Over a week of hourly Bitcoin and Ether contracts its price was better calibrated than our models, and most gaps don&rsquo;t survive the fee.
        </p>
        <Link
          href="/how-it-works"
          data-testid="explainer-link"
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-chip px-4 text-[13px] font-medium text-chip-ink hover:opacity-90"
        >
          How it works <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}
