"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDashboard } from "@/components/DashboardShell";
import { gatewayFetch } from "@/lib/useGateway";

type Lang = "python" | "node" | "curl";
type TestOption = { provider: string; model: string };
type TestResult = {
  model: string; provider: string | null; content: string; prompt_tokens: number | null;
  completion_tokens: number | null; cost_usd: number | null; cost_status: string | null; latency_ms: number;
};

const STEPS = ["Create a key", "Send a request", "Connect your tools"];

function snippet(lang: Lang, url: string, key: string, model: string) {
  if (lang === "python") {
    return `from openai import OpenAI

client = OpenAI(base_url="${url}/v1", api_key="${key}")
r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)`;
  }
  if (lang === "node") {
    return `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${url}/v1", apiKey: "${key}" });
const r = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);`;
  }
  return `curl ${url}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`;
}

export default function OnboardingPage() {
  const { notify } = useDashboard();
  const [step, setStep] = useState(0);

  const [keyName, setKeyName] = useState("my-laptop");
  const [creating, setCreating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");

  const [gatewayUrl, setGatewayUrl] = useState("http://localhost:3000");
  const [options, setOptions] = useState<TestOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [lang, setLang] = useState<Lang>("python");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/test-request")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error?.message ?? `HTTP ${r.status}`);
        setOptions(d.providers ?? []);
        if (d.gateway_url) setGatewayUrl(d.gateway_url);
        if (d.providers?.[0]) setModel(d.providers[0].model);
      })
      .catch((e) => setOptionsError(e.message));
  }, []);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyError(null);
    setCreating(true);
    try {
      const out = await gatewayFetch<{ token: string }>("keys", { method: "POST", body: JSON.stringify({ name: keyName.trim() }) });
      setApiKey(out.token);
      setStep(1);
    } catch (err: any) {
      setKeyError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function sendTest() {
    setSending(true);
    setTestError(null);
    setResult(null);
    try {
      const res = await fetch("/api/test-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ virtualKey: apiKey, model }),
      });
      const d = await res.json();
      if (!res.ok || !d.success) throw new Error(d.error ?? `HTTP ${res.status}`);
      setResult(d);
      notify("Request sent — it is now in Request history");
    } catch (err: any) {
      setTestError(err.message);
    } finally {
      setSending(false);
    }
  }

  const shownModel = model || "gpt-4o-mini";
  const code = snippet(lang, gatewayUrl, apiKey || "tktt_live_…", shownModel);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 60 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 32 }}>
        {STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1 }}>
            <div style={{ height: 4, borderRadius: 2, background: i <= step ? "var(--violet)" : "var(--bg-3)" }} />
            <div className="mono" style={{ fontSize: 11, marginTop: 6, color: i === step ? "var(--violet)" : i < step ? "var(--fg-2)" : "var(--fg-4)" }}>
              {i + 1}. {s}
            </div>
          </div>
        ))}
      </div>

      {step === 0 && (
        <form onSubmit={createKey} className="card" style={{ padding: 22 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 6px" }}>Create your API key</h2>
          <p style={{ fontSize: 14, color: "var(--fg-3)", margin: "0 0 18px", lineHeight: 1.5 }}>
            Your apps and editors use this key instead of a provider key. Tokenistt forwards each request to the provider and records its cost.
          </p>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>NAME</span>
            <input className="mono dash-input" required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          </label>
          {keyError && <div className="mono" style={{ color: "var(--red)", fontSize: 12.5, marginBottom: 12 }}>{keyError}</div>}
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="submit" className="btn btn-violet" disabled={creating || !keyName.trim()}>{creating ? "Creating…" : "Create key"}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>I already have a key</button>
          </div>
        </form>
      )}

      {step === 1 && (
        <div className="card" style={{ padding: 22 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 6px" }}>Send a request</h2>
          {apiKey ? (
            <div style={{ marginBottom: 16 }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--violet)", marginBottom: 6 }}>YOUR KEY · shown once — copy it now</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <code className="mono" style={{ fontSize: 12.5, wordBreak: "break-all", flex: 1 }}>{apiKey}</code>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(apiKey); notify("Key copied"); }}>Copy</button>
              </div>
            </div>
          ) : (
            <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>YOUR API KEY</span>
              <input className="mono dash-input" value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} placeholder="tktt_live_…" />
            </label>
          )}

          <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>MODEL</span>
            {options.length > 0 ? (
              <select className="mono dash-select" value={model} onChange={(e) => setModel(e.target.value)}>
                {options.map((o) => <option key={o.model} value={o.model}>{o.model} ({o.provider})</option>)}
              </select>
            ) : (
              <input className="mono dash-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
            )}
            {optionsError && <span className="mono" style={{ fontSize: 12, color: "var(--red)" }}>{optionsError}</span>}
            {!optionsError && options.length === 0 && (
              <span style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                No provider is configured on the gateway yet. Set <code>MOCK_PROVIDER=1</code> to try it offline, or add a provider key under <Link href="/providers" style={{ color: "var(--violet)" }}>Providers &amp; Keys</Link>.
              </span>
            )}
          </label>

          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {(["python", "node", "curl"] as Lang[]).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)} className="mono"
                style={{ padding: "4px 10px", fontSize: 12, borderRadius: 4, cursor: "pointer", border: "1px solid " + (lang === l ? "var(--violet)" : "var(--line-soft)"), background: "transparent", color: lang === l ? "var(--violet)" : "var(--fg-3)" }}>
                {l}
              </button>
            ))}
          </div>
          <pre className="mono" style={{ background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6, padding: 14, fontSize: 12.5, overflowX: "auto", margin: "0 0 16px" }}>{code}</pre>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-violet" disabled={sending || !apiKey || !model} onClick={sendTest}>{sending ? "Sending…" : "Send it from here"}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>{result ? "Continue →" : "Skip"}</button>
          </div>
          {testError && <div className="mono" style={{ color: "var(--red)", fontSize: 12.5, marginTop: 12 }}>{testError}</div>}
          {result && (
            <div style={{ marginTop: 16, padding: "12px 14px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6 }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>REPLY</div>
              <div style={{ fontSize: 14, margin: "4px 0 10px" }}>{result.content || "(empty reply)"}</div>
              <div className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                {result.provider ?? "provider"} · {result.prompt_tokens ?? "?"} in / {result.completion_tokens ?? "?"} out tokens ·{" "}
                {result.cost_usd == null ? "cost n/a" : result.cost_status === "COST_UNAVAILABLE" ? "price unknown ($0)" : `$${result.cost_usd.toFixed(6)}`} · {result.latency_ms} ms
              </div>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="card" style={{ padding: 22 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 6px" }}>Connect your tools</h2>
          <p style={{ fontSize: 14, color: "var(--fg-3)", margin: "0 0 14px", lineHeight: 1.5 }}>
            Anything that accepts an OpenAI base URL works. Use <code className="mono">{gatewayUrl}/v1</code> and your key in Continue, Cline, the OpenAI SDKs, LangChain and the rest.
            Cursor needs a publicly reachable HTTPS URL — see the guide.
          </p>
          <ul style={{ fontSize: 14, color: "var(--fg-2)", lineHeight: 1.9, paddingLeft: 18, margin: "0 0 18px" }}>
            <li><Link href="/docs" style={{ color: "var(--violet)" }}>Editor &amp; SDK setup guide</Link> (VS Code, Continue, Cline, Cursor, MCP)</li>
            <li><Link href="/requests" style={{ color: "var(--violet)" }}>Request history</Link> — every call, with cost and latency</li>
            <li><Link href="/providers" style={{ color: "var(--violet)" }}>Providers &amp; Keys</Link> — add your OpenAI / Anthropic / Groq keys</li>
            <li><Link href="/budgets" style={{ color: "var(--violet)" }}>Budgets</Link> and <Link href="/routing" style={{ color: "var(--violet)" }}>Routing</Link> — control spend</li>
            <li><Link href="/keys" style={{ color: "var(--violet)" }}>API keys</Link> — create more, revoke old ones</li>
          </ul>
          <Link href="/" className="btn btn-violet">Go to the dashboard</Link>
        </div>
      )}
    </div>
  );
}
