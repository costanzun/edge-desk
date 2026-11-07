import type {
  Capital, ControlResult, Desk, Health, KellyInput, KellyResult, Latency, Models, Periods, Positions,
  ReplayJob, ReplayRequest, Report, Risk, Settings, SettingsUpdate,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8104").replace(/\/$/, "");
/** NEXT_PUBLIC_MOCK=1 serves the fixtures in src/mocks (Playwright, screenshots; no backend needed). */
export const MOCK = process.env.NEXT_PUBLIC_MOCK === "1";

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

// The fixtures are only bundled into the mock build's chunk.
const mock = () => import("./mock");

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      cache: "no-store",
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("The API is not reachable. Is the backend running on port 8104?");
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (Array.isArray(body?.detail)) detail = body.detail.map((d: { msg?: string }) => d.msg).join("; ");
      else if (body?.detail) detail = String(body.detail);
    } catch {}
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const getHealth = async () => (MOCK ? (await mock()).health() : req<Health>("/health"));
export const getDesk = async () => (MOCK ? (await mock()).desk() : req<Desk>("/desk"));
export const getPositions = async () => (MOCK ? (await mock()).positions() : req<Positions>("/positions"));
export const getRisk = async () => (MOCK ? (await mock()).risk() : req<Risk>("/risk"));
export const getCapital = async () => (MOCK ? (await mock()).capital() : req<Capital>("/capital"));
export const getModels = async () => (MOCK ? (await mock()).models() : req<Models>("/models"));
export const getLatency = async () => (MOCK ? (await mock()).latency() : req<Latency>("/latency"));
export const getSettings = async () => (MOCK ? (await mock()).settings() : req<Settings>("/settings"));
export const getPeriods = async () => (MOCK ? (await mock()).periods() : req<Periods>("/replay/periods"));

export async function kill(reason: string): Promise<ControlResult> {
  return MOCK ? (await mock()).control("kill", reason) : req<ControlResult>("/risk/kill", post({ reason }));
}
export async function resume(reason: string): Promise<ControlResult> {
  return MOCK ? (await mock()).control("resume", reason) : req<ControlResult>("/risk/resume", post({ reason }));
}

export async function kellyCalc(body: KellyInput): Promise<KellyResult> {
  return MOCK ? (await mock()).kelly(body) : req<KellyResult>("/capital/kelly", post(body));
}

export async function putSettings(body: SettingsUpdate): Promise<Settings> {
  return MOCK ? (await mock()).putSettings(body) : req<Settings>("/settings", { method: "PUT", body: JSON.stringify(body) });
}

export async function startReplay(body: ReplayRequest): Promise<ReplayJob> {
  return MOCK ? (await mock()).startReplay(body) : req<ReplayJob>("/replay", post(body));
}
export async function getReplay(id: string): Promise<ReplayJob> {
  return MOCK ? (await mock()).getReplay(id) : req<ReplayJob>(`/replay/${encodeURIComponent(id)}`);
}

/** The evaluation report is optional: null when the backend has not written one yet (404). */
export async function getReport(): Promise<Report | null> {
  if (MOCK) return (await mock()).report();
  try {
    return await req<Report>("/report");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
