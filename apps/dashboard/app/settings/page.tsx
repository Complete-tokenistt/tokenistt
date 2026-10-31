"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusBadges";

export default function SettingsPage() {
  const [status, setStatus] = useState<Record<string, boolean>>({ openai: false, anthropic: false });
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      setLoading(true);
      const res = await fetch("/api/settings/keys");
      if (!res.ok) throw new Error("Failed to fetch keys configuration status");
      const data = await res.json();
      setStatus(data);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey) return;

    try {
      setSaving(true);
      setMessage(null);
      const res = await fetch("/api/settings/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      });

      if (!res.ok) throw new Error("Failed to save credentials");

      setMessage({ text: `Successfully encrypted and updated ${provider.toUpperCase()} credential!`, type: "success" });
      setApiKey("");
      fetchStatus();
    } catch (err: any) {
      setMessage({ text: err.message || "An error occurred", type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 24 }}>
        <div className="card" style={{ padding: 20 }}>
          <div className="mono dash-section-label" style={{ marginBottom: 12 }}>ENCRYPTION STATUS</div>
          <p style={{ fontSize: 13, color: "var(--fg-3)", lineHeight: 1.55 }}>
            Tokenistt secures all external API credentials using <strong style={{ color: "var(--fg-1)" }}>AES-256-GCM</strong>. Decryption occurs only in-memory on the gateway during request execution and is never stored in plaintext.
          </p>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-soft)", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>OpenAI Direct</span>
              {loading ? <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)" }}>…</span> : <StatusPill status={status.openai ? "connected" : "planned"} />}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>Anthropic Direct</span>
              {loading ? <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)" }}>…</span> : <StatusPill status={status.anthropic ? "connected" : "planned"} />}
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 22 }}>
          <div className="mono dash-section-label" style={{ marginBottom: 4 }}>UPDATE SECURE CREDENTIALS</div>
          <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginBottom: 18 }}>Overwrite or configure root keys. Plaintext keys are encrypted before hitting the database.</p>

          <form onSubmit={handleSave}>
            {message && (
              <div
                className="mono"
                style={{
                  padding: "10px 14px", marginBottom: 14, borderRadius: 6, fontSize: 12.5,
                  color: message.type === "success" ? "var(--green)" : "var(--red)",
                  border: `1px solid ${message.type === "success" ? "var(--green)" : "var(--red)"}`,
                }}
              >
                {message.text}
              </div>
            )}

            <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>PROVIDER</span>
                <select className="mono dash-select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="openai">OpenAI Direct (sk-proj-...)</option>
                  <option value="anthropic">Anthropic (sk-ant-api03-...)</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>API KEY</span>
                <input className="mono dash-input" type="password" required placeholder="••••••••••••••••••••••••••••••••" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </label>
            </div>

            <div style={{ padding: "12px 14px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6, marginBottom: 18 }}>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.55 }}>
                ⚠ Saved API keys are fully masked and undecryptable by standard users or other dashboard employees. Keys can only be overwritten, never read or downloaded.
              </span>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="btn btn-violet btn-sm" disabled={saving || !apiKey}>
                {saving ? "Encrypting & Saving..." : "Update Credential"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
