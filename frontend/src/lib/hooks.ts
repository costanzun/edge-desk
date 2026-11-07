"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, MOCK } from "./api";

export interface Poll<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetch on mount and then every `intervalMs` (live mode only; the mock data is static).
 * Keeps the last good data when a refresh fails, pauses while the tab is hidden.
 * `key`: refetch immediately whenever it changes (e.g. after a kill switch press).
 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs?: number, key?: unknown): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fn = useRef(fetcher);
  useEffect(() => {
    fn.current = fetcher;
  });

  const refresh = useCallback(async () => {
    try {
      const d = await fn.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && !document.hidden) void refresh();
    };
    void refresh();
    if (!intervalMs || MOCK) return () => void (alive = false);
    const id = window.setInterval(tick, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [refresh, intervalMs, key]);

  return { data, error, loading, refresh };
}

/** Debounced value. */
export function useDebounced<T>(value: T, delay = 150): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return v;
}
