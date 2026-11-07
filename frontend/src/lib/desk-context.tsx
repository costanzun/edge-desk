"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import * as api from "./api";
import { usePoll } from "./hooks";
import type { Desk, Health } from "./types";

interface DeskCtx {
  desk: Desk | null;
  health: Health | null;
  error: string | null;
  loading: boolean;
  halted: boolean;
  haltReason: string;
  mode: string;
  /** Bumped after every kill / resume so pages can refetch. */
  version: number;
  kill: (reason: string) => Promise<void>;
  resume: (reason: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<DeskCtx | null>(null);

/** One desk poll (2 s, live) shared by the shell (ticker, banner, mode badge) and the Desk page. */
export function DeskProvider({ children }: { children: ReactNode }) {
  const desk = usePoll(api.getDesk, 2000);
  const health = usePoll(api.getHealth, 15000);
  const [version, setVersion] = useState(0);
  const refreshDesk = desk.refresh;

  const kill = useCallback(async (reason: string) => {
    await api.kill(reason);
    await refreshDesk();
    setVersion((v) => v + 1);
  }, [refreshDesk]);

  const resume = useCallback(async (reason: string) => {
    await api.resume(reason);
    await refreshDesk();
    setVersion((v) => v + 1);
  }, [refreshDesk]);

  const value = useMemo<DeskCtx>(() => {
    const d = desk.data;
    const mode = api.MOCK ? "mock" : (d?.mode ?? d?.desk?.source ?? health.data?.source ?? "").toLowerCase();
    return {
      desk: d,
      health: health.data,
      error: desk.error,
      loading: desk.loading,
      halted: !!(d?.halted ?? d?.summary?.halted),
      haltReason: d?.halt_reason || d?.summary?.halt_reason || "",
      mode,
      version,
      kill,
      resume,
      refresh: refreshDesk,
    };
  }, [desk.data, desk.error, desk.loading, health.data, version, kill, resume, refreshDesk]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDesk(): DeskCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDesk outside DeskProvider");
  return c;
}
