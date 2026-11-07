// Mock backend for NEXT_PUBLIC_MOCK=1: serves the fixtures and keeps a little local state so the
// kill switch, settings and replay flows behave like the real API in tests and screenshots.
import capitalJson from "@/mocks/capital.json";
import deskJson from "@/mocks/desk.json";
import healthJson from "@/mocks/health.json";
import latencyJson from "@/mocks/latency.json";
import modelsJson from "@/mocks/models.json";
import periodsJson from "@/mocks/periods.json";
import positionsJson from "@/mocks/positions.json";
import replayJson from "@/mocks/replay_job.json";
import riskJson from "@/mocks/risk.json";
import settingsJson from "@/mocks/settings.json";
import { kelly as kellyCalc } from "./kelly";
import type {
  Capital, ControlResult, Desk, HaltEvent, Health, KellyInput, KellyResult, Latency, Models, Periods,
  Positions, ReplayJob, ReplayRequest, Report, Risk, Settings, SettingsUpdate,
} from "./types";

const clone = <T,>(x: unknown): T => structuredClone(x) as T;
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const state = {
  halted: false,
  reason: "",
  halts: [] as HaltEvent[],
  settings: clone<Settings>(settingsJson),
  jobs: new Map<string, { job: ReplayJob; ready: number }>(),
};

export async function health(): Promise<Health> {
  await wait();
  return clone(healthJson);
}

export async function desk(): Promise<Desk> {
  await wait();
  const d = clone<Desk>(deskJson);
  d.halted = state.halted;
  d.halt_reason = state.reason;
  if (d.summary) Object.assign(d.summary, { halted: state.halted, halt_reason: state.reason });
  return d;
}

export async function positions(): Promise<Positions> {
  await wait();
  return clone(positionsJson);
}

export async function risk(): Promise<Risk> {
  await wait();
  const r = clone<Risk>(riskJson);
  r.halted = state.halted;
  r.halt_reason = state.reason;
  r.halts = [...(r.halts ?? []), ...state.halts];
  return r;
}

export async function control(action: "kill" | "resume", reason: string): Promise<ControlResult> {
  await wait(150);
  state.halted = action === "kill";
  state.reason = action === "kill" ? reason || "manual kill switch" : "";
  const ev = { t: (deskJson as Desk).t ?? 0, action, reason, halted: state.halted };
  state.halts.push(ev);
  return ev;
}

export async function capital(): Promise<Capital> {
  await wait();
  return clone(capitalJson);
}

export async function kelly(body: KellyInput): Promise<KellyResult> {
  return kellyCalc(body);
}

export async function models(): Promise<Models> {
  await wait();
  const m = clone<Models>(modelsJson);
  m.kumo = { ...m.kumo, enabled: !!state.settings.kumo_enabled };
  return m;
}

export async function latency(): Promise<Latency> {
  await wait();
  return clone(latencyJson);
}

export async function settings(): Promise<Settings> {
  await wait();
  return clone(state.settings);
}

export async function putSettings(body: SettingsUpdate): Promise<Settings> {
  await wait(300);
  const { limits, ...rest } = body;
  state.settings = { ...state.settings, ...rest, limits: { ...state.settings.limits, ...(limits ?? {}) } };
  state.settings.kumo = { ...state.settings.kumo, enabled: !!state.settings.kumo_enabled };
  return clone(state.settings);
}

export async function periods(): Promise<Periods> {
  await wait();
  return clone(periodsJson);
}

export async function startReplay(body: ReplayRequest): Promise<ReplayJob> {
  await wait(150);
  const id = `mock${(state.jobs.size + 1).toString().padStart(4, "0")}`;
  const job: ReplayJob = { id, status: "running", request: body };
  state.jobs.set(id, { job, ready: Date.now() + 1500 });
  return clone(job);
}

export async function getReplay(id: string): Promise<ReplayJob> {
  await wait();
  const j = state.jobs.get(id);
  if (!j) throw new Error("unknown job");
  if (Date.now() < j.ready) return clone(j.job);
  const done = clone<ReplayJob>(replayJson);
  // the fixture only has edge decay when latencies were requested
  if (!j.job.request?.latencies_ms?.length && done.result) delete done.result.edge_decay;
  return { ...done, id, request: j.job.request };
}

export async function report(): Promise<Report | null> {
  await wait();
  return null;
}
