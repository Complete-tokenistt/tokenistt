"use client";

import { useEffect, useState } from "react";
import Section from "@/components/Section";

export default function SettingsPage() {
  const [status, setStatus] = useState<Record<string, boolean>>({
    openai: false,
    anthropic: false
  });
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
        body: JSON.stringify({ provider, apiKey })
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
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900">Security & Credentials</h2>
        <p className="text-sm text-slate-500">
          Manage your organization's root API keys securely. All credentials are encrypted in Transit and at Rest.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Left Side: status overview */}
        <div className="md:col-span-1 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <h3 className="font-semibold text-slate-900 text-sm">Encryption Status</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Tokenistt secures all external API credentials using <strong>AES-256-GCM</strong>. Decryption occurs only in-memory on the gateway during request execution and is never stored in plaintext.
            </p>

            <div className="border-t border-slate-100 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">OpenAI Direct</span>
                {loading ? (
                  <span className="h-4 w-12 animate-pulse rounded bg-slate-100" />
                ) : status.openai ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-2xs font-semibold text-emerald-700 ring-1 ring-emerald-600/10">
                    🔒 Encrypted
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-2xs font-semibold text-amber-700 ring-1 ring-amber-600/10">
                    ⚠️ Not Configured
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">Anthropic Direct</span>
                {loading ? (
                  <span className="h-4 w-12 animate-pulse rounded bg-slate-100" />
                ) : status.anthropic ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-2xs font-semibold text-emerald-700 ring-1 ring-emerald-600/10">
                    🔒 Encrypted
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-2xs font-semibold text-amber-700 ring-1 ring-amber-600/10">
                    ⚠️ Not Configured
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Key updater form */}
        <div className="md:col-span-2">
          <Section
            title="Update Secure Credentials"
            description="Overwrite or configure root keys. Plaintext keys are encrypted before hitting the database."
          >
            <form onSubmit={handleSave} className="space-y-4">
              {message && (
                <div
                  className={`rounded-lg p-3 text-xs font-medium ${
                    message.type === "success" ? "bg-emerald-50 text-emerald-700 border border-emerald-100" : "bg-rose-50 text-rose-700 border border-rose-100"
                  }`}
                >
                  {message.text}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Provider</label>
                  <select
                    value={provider}
                    onChange={e => setProvider(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  >
                    <option value="openai">OpenAI Direct (sk-proj-...)</option>
                    <option value="anthropic">Anthropic (sk-ant-api03-...)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700">API Key</label>
                  <input
                    type="password"
                    required
                    placeholder="••••••••••••••••••••••••••••••••"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 p-4 border border-slate-100">
                <div className="flex gap-2">
                  <svg className="h-4.5 w-4.5 text-slate-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="text-2xs text-slate-500 leading-normal">
                    <strong>Important Security Warning:</strong> Saved API keys are fully masked and undecryptable by standard users or other dashboard employees. Keys can only be overwritten, never read or downloaded.
                  </div>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={saving || !apiKey}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500 shadow-sm transition-colors disabled:opacity-50"
                >
                  {saving ? "Encrypting & Saving..." : "Update Credential"}
                </button>
              </div>
            </form>
          </Section>
        </div>
      </div>
    </div>
  );
}
