"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useDashboard } from "@/components/DashboardShell";
import { API_KEYS } from "@/lib/dashboard-mock-data";

const STEPS = ["connect", "api key", "integrate", "confirm"];

export default function OnboardingPage() {
  const { workspace, notify } = useDashboard();
  const [step, setStep] = useState(0);
  const [providerConnected, setProviderConnected] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [firstRequestLanded, setFirstRequestLanded] = useState(false);
  const key = API_KEYS[0];

  function connectProvider() {
    setProviderConnected(true);
    notify("Provider connected");
  }

  function copyKey() {
    navigator.clipboard?.writeText(key.prefix);
    setKeyCopied(true);
  }

  function sendTestRequest() {
    setFirstRequestLanded(true);
    notify("Test request completed");
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
        {STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1 }}>
            <div style={{ height: 4, borderRadius: 2, background: i <= step ? "var(--violet)" : "var(--bg-3)" }} />
            <div className="mono" style={{ fontSize: 11.5, color: i === step ? "var(--violet)" : "var(--fg-4)", marginTop: 6, textTransform: "uppercase" }}>
              {i + 1} · {s}
            </div>
          </div>
        ))}
      </div>

      {step === 0 && (
        <StepCard num="01" title="Connect your first provider" desc="Paste an existing API key, or generate one now with your provider. Tokenistt routes and tracks every request the moment this is connected.">
          <button type="button" className="btn btn-violet" onClick={connectProvider}>
            {providerConnected ? "✓ Provider connected" : "Connect a provider →"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!providerConnected} onClick={() => setStep(1)} style={{ marginLeft: 10 }}>
            Continue
          </button>
        </StepCard>
      )}

      {step === 1 && (
        <StepCard num="02" title="Get your Tokenistt API key" desc="Your app calls this key, not the provider directly — that's what lets the gateway track cost, enforce budgets, and route traffic.">
          <div className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, marginBottom: 16, maxWidth: 460 }}>
            <span className="mono" style={{ fontSize: 14, color: "var(--violet)", flex: 1 }}>{key.prefix}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyKey}>{keyCopied ? "✓ copied" : "copy"}</button>
          </div>
          <button type="button" className="btn btn-violet" onClick={() => setStep(2)}>Continue</button>
        </StepCard>
      )}

      {step === 2 && (
        <StepCard num="03" title="One line to integrate" desc="Point your existing OpenAI/Anthropic SDK base URL at the gateway. No other code changes.">
          <pre className="mono" style={{ margin: "0 0 16px", whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.8, color: "var(--fg-1)", background: "var(--bg-2)", padding: "16px 18px", borderRadius: 6, border: "1px solid var(--line-soft)", maxWidth: 560 }}>
{`client = OpenAI(base_url="https://gateway.tokenistt.dev/v1",
                 api_key="`}<span style={{ color: "var(--violet)" }}>{key.prefix}</span>{`")`}
          </pre>
          <button type="button" className="btn btn-violet" onClick={() => setStep(3)}>Continue</button>
        </StepCard>
      )}

      {step === 3 && (
        <StepCard num="04" title="Waiting for your first request" desc="This is the moment that proves it works — send one real request through the gateway.">
          {!firstRequestLanded ? (
            <button type="button" className="btn btn-violet" onClick={sendTestRequest}>Send a test request →</button>
          ) : (
            <div className="card" style={{ padding: 20, maxWidth: 460, borderColor: "oklch(0.420 0.150 295 / 0.4)", background: "oklch(0.420 0.150 295 / 0.08)" }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--violet)", marginBottom: 8 }}>✓ FIRST REQUEST RECEIVED</div>
              <div style={{ fontSize: 15, color: "var(--fg)" }}>claude-haiku-4.5 · 340 tokens · $0.0009 · 612ms</div>
              <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 10, lineHeight: 1.55 }}>
                {workspace} is live. Cost, budgets, and routing are tracking from here.
              </p>
              <Link href="/" className="btn btn-primary" style={{ marginTop: 14 }}>Go to Overview →</Link>
            </div>
          )}
        </StepCard>
      )}
    </div>
  );
}

function StepCard({ num, title, desc, children }: { num: string; title: string; desc: string; children: ReactNode }) {
  return (
    <div className="card" style={{ padding: 28, maxWidth: 620 }}>
      <div className="mono" style={{ fontSize: 12, color: "var(--violet)", marginBottom: 10 }}>{num}</div>
      <h2 style={{ fontSize: 22, marginBottom: 10, color: "var(--fg)" }}>{title}</h2>
      <p style={{ fontSize: 14.5, color: "var(--fg-3)", lineHeight: 1.6, marginBottom: 22 }}>{desc}</p>
      {children}
    </div>
  );
}
