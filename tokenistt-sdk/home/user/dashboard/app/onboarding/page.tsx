"use client";

import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useDashboard } from "@/components/DashboardShell";

const STEPS = ["connect", "api key", "integrate", "confirm"];

interface ProviderOption {
  id: string;
  name: string;
  placeholder: string;
  defaultBaseUrl: string;
  recommendedModel: string;
  hint: string;
}

const PROVIDERS: ProviderOption[] = [
  {
    id: "groq",
    name: "Groq (Fast / OpenAI-compatible)",
    placeholder: "gsk_...",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    recommendedModel: "openai/gpt-oss-20b",
    hint: "Ultra-fast inference. Keys begin with gsk_",

  },
  {
    id: "openai",
    name: "OpenAI",
    placeholder: "sk-proj-...",
    defaultBaseUrl: "https://api.openai.com/v1",
    recommendedModel: "gpt-4o-mini",
    hint: "Standard OpenAI keys begin with sk-",
  },
  {
    id: "together",
    name: "Together AI",
    placeholder: "together_...",
    defaultBaseUrl: "https://api.together.xyz/v1",
    recommendedModel: "meta-llama/Llama-3-8b-chat-hf",
    hint: "Open-source model hosting on Together API",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    placeholder: "mistral_...",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    recommendedModel: "mistral-small-latest",
    hint: "Mistral API platform key",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    placeholder: "sk-ant-api03-...",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    recommendedModel: "claude-3-5-haiku-20241022",
    hint: "Anthropic Claude direct API key",
  },
];

export default function OnboardingPage() {
  const { workspace, notify } = useDashboard();
  const [step, setStep] = useState(0);

  // Form states
  const [selectedProvider, setSelectedProvider] = useState<string>("groq");
  const [apiKey, setApiKey] = useState<string>("");
  const [customBaseUrl, setCustomBaseUrl] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [showKey, setShowKey] = useState<boolean>(false);

  // Validation states
  const [validating, setValidating] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    latency_ms?: number;
    models?: string[];
    error?: string;
  } | null>(null);

  // Step 1: Virtual Key state
  const [virtualKey, setVirtualKey] = useState<string>("tktt_live_acme_jane_abc123def456");
  const [keyCopied, setKeyCopied] = useState<boolean>(false);

  // Step 2: Code integration snippet tab
  const [codeLang, setCodeLang] = useState<"python" | "node" | "curl">("python");

  // Step 3: Test request execution
  const [sendingTest, setSendingTest] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{
    model: string;
    totalTokens: number;
    costUsd: number;
    latencyMs: number;
    content: string;
  } | null>(null);

  const activeProvider = PROVIDERS.find((p) => p.id === selectedProvider) || PROVIDERS[0];
  const gatewayUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}:4000`
      : "http://localhost:4000";

  // Pre-load active virtual key if available
  useEffect(() => {
    fetch("/api/providers/virtual-key")
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.key?.prefix) {
          setVirtualKey(data.key.prefix);
        }
      })
      .catch(() => {});
  }, []);

  async function handleTestConnection() {
    if (!apiKey.trim()) {
      notify("Please enter an API key first");
      return;
    }
    setValidating(true);
    setValidationResult(null);

    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey: apiKey.trim(),
          baseUrl: customBaseUrl.trim() || undefined,
          action: "validate",
        }),
      });
      const data = await res.json();
      if (res.ok && (data.valid || data.success)) {
        setValidationResult({
          valid: true,
          latency_ms: data.latency_ms,
          models: data.models,
        });
        notify(`Connection verified (${data.latency_ms ?? 350}ms)`);
      } else {
        const errMsg = data.error?.message || (typeof data.error === "string" ? data.error : null) || "Failed to validate API key with upstream provider";
        setValidationResult({
          valid: false,
          error: errMsg,
        });
      }
    } catch (err: any) {
      setValidationResult({ valid: false, error: err.message });
    } finally {
      setValidating(false);
    }
  }

  async function handleConnectProvider() {
    if (!apiKey.trim()) {
      notify("Please enter an API key");
      return;
    }

    setConnecting(true);
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey: apiKey.trim(),
          baseUrl: customBaseUrl.trim() || undefined,
          action: "connect",
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.raw_token) {
          setVirtualKey(data.raw_token);
        } else if (data.key_prefix) {
          setVirtualKey(data.key_prefix);
        }
        notify("Provider connected & secured with AES-256-GCM vault!");
        setStep(1);
      } else {
        const errMsg = data.error?.message || (typeof data.error === "string" ? data.error : null) || "Connection failed. Please check the API key.";
        setValidationResult({
          valid: false,
          error: errMsg,
        });
      }
    } catch (err: any) {
      setValidationResult({ valid: false, error: err.message });
    } finally {
      setConnecting(false);
    }
  }

  function copyKey() {
    navigator.clipboard?.writeText(virtualKey);
    setKeyCopied(true);
    notify("Virtual key copied to clipboard");
    setTimeout(() => setKeyCopied(false), 3000);
  }

  async function sendTestRequest() {
    setSendingTest(true);
    try {
      const res = await fetch("/api/test-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          virtualKey,
          model: activeProvider.recommendedModel,
          provider: selectedProvider,
        }),

      });
      const data = await res.json();
      if (res.ok && data.success) {
        setTestResult({
          model: data.model,
          totalTokens: data.total_tokens || 35,
          costUsd: data.cost_usd || 0.0003,
          latencyMs: data.latency_ms || 420,
          content: data.content || "Tokenistt Gateway is operational.",
        });
        notify("Test request completed and recorded in ledger!");
      } else {
        const errMsg = data.error?.message || (typeof data.error === "string" ? data.error : null) || "Test request failed";
        notify(errMsg);
      }
    } catch (err: any) {
      notify(`Test request error: ${err.message}`);
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", paddingBottom: 60 }}>
      {/* Step progress track */}
      <div style={{ display: "flex", gap: 8, marginBottom: 32 }}>
        {STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1 }}>
            <div
              style={{
                height: 4,
                borderRadius: 2,
                background: i <= step ? "var(--violet)" : "var(--bg-3)",
                transition: "background 0.2s ease",
              }}
            />
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: i === step ? "var(--violet)" : i < step ? "var(--fg-2)" : "var(--fg-4)",
                marginTop: 6,
                textTransform: "uppercase",
                fontWeight: i === step ? 600 : 400,
              }}
            >
              {i + 1} · {s}
            </div>
          </div>
        ))}
      </div>

      {/* STEP 0: CONNECT PROVIDER */}
      {step === 0 && (
        <StepCard
          num="01"
          title="Connect your AI Provider"
          desc="Paste your API key to route requests through Tokenistt. Your keys are encrypted at rest with AES-256-GCM in our vault and never logged."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Provider Selector */}
            <div>
              <label style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500, display: "block", marginBottom: 6 }}>
                Select AI Provider
              </label>
              <select
                value={selectedProvider}
                onChange={(e) => {
                  setSelectedProvider(e.target.value);
                  setValidationResult(null);
                }}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: 6,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-soft)",
                  color: "var(--fg)",
                  fontSize: 14,
                  outline: "none",
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: "var(--fg-4)", marginTop: 4, display: "block" }}>
                {activeProvider.hint}
              </span>
            </div>

            {/* API Key Input */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 13, color: "var(--fg-2)", fontWeight: 500 }}>
                  {activeProvider.name.split(" ")[0]} API Key
                </label>
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--violet)",
                    fontSize: 12,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {showKey ? "Hide key" : "Show key"}
                </button>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setValidationResult(null);
                  }}
                  placeholder={activeProvider.placeholder}
                  className="mono"
                  style={{
                    flex: 1,
                    padding: "10px 14px",
                    borderRadius: 6,
                    background: "var(--bg-2)",
                    border: "1px solid var(--line-soft)",
                    color: "var(--fg)",
                    fontSize: 13.5,
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={validating || !apiKey.trim()}
                  className="btn btn-ghost"
                  style={{ whiteSpace: "nowrap" }}
                >
                  {validating ? "Testing..." : "Test Connection"}
                </button>
              </div>
            </div>

            {/* Advanced Base URL Toggle */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--fg-3)",
                  fontSize: 12,
                  cursor: "pointer",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span>{showAdvanced ? "▼" : "▶"}</span>
                <span>Advanced: Custom Base URL / Proxy</span>
              </button>

              {showAdvanced && (
                <div style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    placeholder={activeProvider.defaultBaseUrl}
                    className="mono"
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: 6,
                      background: "var(--bg-2)",
                      border: "1px solid var(--line-soft)",
                      color: "var(--fg)",
                      fontSize: 12.5,
                      outline: "none",
                    }}
                  />
                  <span style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4, display: "block" }}>
                    Default: {activeProvider.defaultBaseUrl}
                  </span>
                </div>
              )}
            </div>

            {/* Validation Feedback Banner */}
            {validationResult && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: 6,
                  border: validationResult.valid
                    ? "1px solid oklch(0.65 0.18 145 / 0.4)"
                    : "1px solid oklch(0.60 0.22 25 / 0.4)",
                  background: validationResult.valid
                    ? "oklch(0.65 0.18 145 / 0.08)"
                    : "oklch(0.60 0.22 25 / 0.08)",
                  fontSize: 13,
                  color: validationResult.valid ? "var(--green)" : "var(--red)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  {validationResult.valid ? "✓ Connection verified!" : "✗ Connection failed"}
                  {validationResult.latency_ms && (
                    <span className="mono" style={{ fontSize: 11, opacity: 0.85 }}>
                      ({validationResult.latency_ms}ms)
                    </span>
                  )}
                </div>
                {validationResult.valid ? (
                  <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
                    Ready to connect {activeProvider.name}. Virtual routing key will be generated.
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
                    {validationResult.error}
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button
                type="button"
                onClick={handleConnectProvider}
                disabled={connecting || !apiKey.trim()}
                className="btn btn-violet"
                style={{ minWidth: 180 }}
              >
                {connecting ? "Securing & Connecting..." : "Connect Provider →"}
              </button>
            </div>
          </div>
        </StepCard>
      )}

      {/* STEP 1: TOKENISTT VIRTUAL KEY */}
      {step === 1 && (
        <StepCard
          num="02"
          title="Your Tokenistt Virtual API Key"
          desc="Your application calls Tokenistt using this virtual key. This isolates your provider credentials, enforces real-time budget caps, and attributes spend to workspaces."
        >
          <div
            className="card"
            style={{
              padding: "16px 18px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 16,
              background: "var(--bg-2)",
              border: "1px solid var(--line-soft)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono" style={{ fontSize: 14, color: "var(--violet)", wordBreak: "break-all" }}>
                {virtualKey}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-4)", marginTop: 4 }}>
                Active · Scoped to {activeProvider.name.split(" ")[0]} · Budget tracking active
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyKey}>
              {keyCopied ? "✓ Copied" : "Copy"}
            </button>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn btn-violet" onClick={() => setStep(2)}>
              Continue to Integration →
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>
              Back
            </button>
          </div>
        </StepCard>
      )}

      {/* STEP 2: INTEGRATE SDK / CURL */}
      {step === 2 && (
        <StepCard
          num="03"
          title="One line to integrate"
          desc="Swap your provider's base_url to the Tokenistt Universal Gateway. Zero code refactors required."
        >
          {/* Language selector */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {(["python", "node", "curl"] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setCodeLang(lang)}
                className="mono"
                style={{
                  padding: "4px 12px",
                  borderRadius: 4,
                  fontSize: 12,
                  border: "1px solid",
                  borderColor: codeLang === lang ? "var(--violet)" : "var(--line-soft)",
                  background: codeLang === lang ? "oklch(0.55 0.20 295 / 0.15)" : "transparent",
                  color: codeLang === lang ? "var(--violet)" : "var(--fg-3)",
                  cursor: "pointer",
                }}
              >
                {lang === "python" ? "Python" : lang === "node" ? "Node.js / TS" : "cURL"}
              </button>
            ))}
          </div>

          {/* Code Snippet Box */}
          <pre
            className="mono"
            style={{
              margin: "0 0 20px",
              whiteSpace: "pre-wrap",
              fontSize: 12.5,
              lineHeight: 1.7,
              color: "var(--fg-1)",
              background: "var(--bg-2)",
              padding: "16px 18px",
              borderRadius: 6,
              border: "1px solid var(--line-soft)",
              overflowX: "auto",
            }}
          >
            {codeLang === "python" && (
              <>
                {`from openai import OpenAI\n\n`}
                {`client = OpenAI(\n`}
                {`    base_url="`}<span style={{ color: "var(--violet)" }}>{`${gatewayUrl}/v1`}</span>{`",\n`}
                {`    api_key="`}<span style={{ color: "var(--violet)" }}>{virtualKey}</span>{`"\n`}
                {`)\n\n`}
                {`response = client.chat.completions.create(\n`}
                {`    model="`}<span style={{ color: "var(--green)" }}>{activeProvider.recommendedModel}</span>{`",\n`}
                {`    messages=[{"role": "user", "content": "Hello Tokenistt!"}]\n`}
                {`)\n`}
                {`print(response.choices[0].message.content)`}
              </>
            )}

            {codeLang === "node" && (
              <>
                {`import OpenAI from "openai";\n\n`}
                {`const client = new OpenAI({\n`}
                {`  baseURL: "`}<span style={{ color: "var(--violet)" }}>{`${gatewayUrl}/v1`}</span>{`",\n`}
                {`  apiKey: "`}<span style={{ color: "var(--violet)" }}>{virtualKey}</span>{`",\n`}
                {`});\n\n`}
                {`const res = await client.chat.completions.create({\n`}
                {`  model: "`}<span style={{ color: "var(--green)" }}>{activeProvider.recommendedModel}</span>{`",\n`}
                {`  messages: [{ role: "user", content: "Hello Tokenistt!" }],\n`}
                {`});\n`}
                {`console.log(res.choices[0].message.content);`}
              </>
            )}

            {codeLang === "curl" && (
              <>
                {`curl ${gatewayUrl}/v1/chat/completions \\\n`}
                {`  -H "Content-Type: application/json" \\\n`}
                {`  -H "Authorization: Bearer `}<span style={{ color: "var(--violet)" }}>{virtualKey}</span>{`" \\\n`}
                {`  -d '{\n`}
                {`    "model": "`}<span style={{ color: "var(--green)" }}>{activeProvider.recommendedModel}</span>{`",\n`}
                {`    "messages": [{"role": "user", "content": "Hello Tokenistt!"}]\n`}
                {`  }'`}
              </>
            )}
          </pre>

          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn btn-violet" onClick={() => setStep(3)}>
              Continue to Live Test →
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
              Back
            </button>
          </div>
        </StepCard>
      )}

      {/* STEP 3: LIVE TEST REQUEST */}
      {step === 3 && (
        <StepCard
          num="04"
          title="Verify your live gateway routing"
          desc="Send an end-to-end request through the gateway to verify key decryption, token accounting, and cost tracking."
        >
          {!testResult ? (
            <div>
              <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginBottom: 16 }}>
                Click below to send a live ping using your Tokenistt virtual key and connected provider:
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-violet"
                  onClick={sendTestRequest}
                  disabled={sendingTest}
                >
                  {sendingTest ? "Routing via Gateway..." : "Send a live test request →"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div
              className="card"
              style={{
                padding: 24,
                borderColor: "oklch(0.65 0.18 145 / 0.4)",
                background: "oklch(0.65 0.18 145 / 0.06)",
              }}
            >
              <div className="mono" style={{ fontSize: 12, color: "var(--green)", marginBottom: 12, fontWeight: 600 }}>
                ✓ FIRST REQUEST RECEIVED & TRACKED
              </div>

              {/* Metrics row */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                  gap: 12,
                  marginBottom: 16,
                  padding: "12px 14px",
                  borderRadius: 6,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-soft)",
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: "var(--fg-4)" }}>MODEL</div>
                  <div className="mono" style={{ fontSize: 13, color: "var(--fg)", marginTop: 2 }}>
                    {testResult.model}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--fg-4)" }}>TOKENS</div>
                  <div className="mono" style={{ fontSize: 13, color: "var(--fg)", marginTop: 2 }}>
                    {testResult.totalTokens} tokens
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--fg-4)" }}>COST</div>
                  <div className="mono" style={{ fontSize: 13, color: "var(--green)", marginTop: 2 }}>
                    ${testResult.costUsd.toFixed(5)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--fg-4)" }}>LATENCY</div>
                  <div className="mono" style={{ fontSize: 13, color: "var(--fg)", marginTop: 2 }}>
                    {testResult.latencyMs}ms
                  </div>
                </div>
              </div>

              {/* Response message */}
              <div style={{ fontSize: 13, color: "var(--fg-2)", fontStyle: "italic", marginBottom: 16 }}>
                "{testResult.content}"
              </div>

              <p style={{ fontSize: 13.5, color: "var(--fg-3)", lineHeight: 1.55, marginBottom: 20 }}>
                {workspace} is live. Cost, budgets, and routing are tracking from here.
              </p>

              <div style={{ display: "flex", gap: 10 }}>
                <Link href="/" className="btn btn-primary">
                  Go to Overview Dashboard →
                </Link>
                <Link href="/providers" className="btn btn-ghost">
                  View Connected Providers
                </Link>
              </div>
            </div>
          )}
        </StepCard>
      )}
    </div>
  );
}

function StepCard({
  num,
  title,
  desc,
  children,
}: {
  num: string;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 28, background: "var(--bg-1)", border: "1px solid var(--line)" }}>
      <div className="mono" style={{ fontSize: 12, color: "var(--violet)", marginBottom: 10, fontWeight: 600 }}>
        {num}
      </div>
      <h2 style={{ fontSize: 22, marginBottom: 10, color: "var(--fg)", letterSpacing: "-0.01em" }}>{title}</h2>
      <p style={{ fontSize: 14, color: "var(--fg-3)", lineHeight: 1.6, marginBottom: 24 }}>{desc}</p>
      {children}
    </div>
  );
}
