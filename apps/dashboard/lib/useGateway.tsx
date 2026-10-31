"use client";

import { useCallback, useEffect, useState } from "react";

/** Fetch JSON from the gateway management API through the dashboard proxy. */
export async function gatewayFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/gateway/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json as T;
}

export function useGateway<T = any>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await gatewayFetch<T>(path));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}

export function StateNote({ loading, error, empty }: { loading: boolean; error: string | null; empty?: string }) {
  if (loading) return <div className="mono" style={{ color: "var(--fg-3)", fontSize: 13 }}>Loading…</div>;
  if (error) {
    return (
      <div className="mono" style={{ color: "var(--red)", fontSize: 13 }}>
        {error}
        <div style={{ color: "var(--fg-3)", marginTop: 4 }}>
          Is the gateway running and reachable from the dashboard (GATEWAY_URL)?
        </div>
      </div>
    );
  }
  return empty ? <div className="mono" style={{ color: "var(--fg-3)", fontSize: 13 }}>{empty}</div> : null;
}
