"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextUrl = searchParams.get("next") || "/";

  const [email, setEmail] = useState("customer@tokenistt.ai");
  const [password, setPassword] = useState("TestCustomerPass123!");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError("Please provide both email and password.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = await res.json();

      if (!res.ok) {
        const msg = data.error?.message || (typeof data.error === "string" ? data.error : null) || "Invalid credentials";
        setError(msg);
        setLoading(false);
        return;
      }

      if (data.token) {
        localStorage.setItem("tokenistt_token", data.token);
      }
      if (data.user) {
        localStorage.setItem("tokenistt_user", JSON.stringify(data.user));
      }

      // Hard redirect so middleware and server cookies apply fresh
      window.location.href = nextUrl;
    } catch (err: any) {
      setError(err.message || "Failed to communicate with authentication service.");
      setLoading(false);
    }
  }

  return (
    <div style={{
      width: "100%",
      maxWidth: "420px",
      background: "var(--bg-1, #121218)",
      border: "1px solid var(--line, #252532)",
      borderRadius: "12px",
      padding: "36px 32px",
      boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
    }}>
      {/* Brand Header */}
      <div style={{ marginBottom: "28px", textAlign: "center" }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "12px",
        }}>
          <span style={{
            width: "12px",
            height: "12px",
            borderRadius: "50%",
            background: "var(--violet, #7c3aed)",
            boxShadow: "0 0 12px var(--violet, #7c3aed)",
          }} />
          <span className="mono" style={{
            fontSize: "18px",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "var(--fg, #f4f4f6)",
          }}>
            TOKENISTT
          </span>
        </div>
        <h1 style={{
          fontSize: "20px",
          fontWeight: 600,
          color: "var(--fg, #f4f4f6)",
          margin: "0 0 6px 0",
        }}>
          FinOps Customer Portal
        </h1>
        <p style={{
          fontSize: "13px",
          color: "var(--fg-3, #8a8aa3)",
          margin: 0,
          lineHeight: 1.4,
        }}>
          Sign in to inspect AI usage, costs, and budgets
        </p>
      </div>

      {/* Error Alert */}
      {error && (
        <div style={{
          background: "oklch(0.60 0.22 25 / 0.1)",
          border: "1px solid oklch(0.60 0.22 25 / 0.3)",
          color: "var(--red, #ef4444)",
          padding: "10px 14px",
          borderRadius: "6px",
          fontSize: "13px",
          marginBottom: "20px",
          lineHeight: 1.4,
        }}>
          {error}
        </div>
      )}

      {/* Login Form */}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label style={{
            display: "block",
            fontSize: "12.5px",
            fontWeight: 500,
            color: "var(--fg-2, #b8b8cc)",
            marginBottom: "6px",
          }}>
            Work Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="customer@tokenistt.ai"
            required
            className="mono"
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: "6px",
              background: "var(--bg-2, #181822)",
              border: "1px solid var(--line-soft, #2b2b3b)",
              color: "var(--fg, #f4f4f6)",
              fontSize: "13.5px",
              outline: "none",
              transition: "border-color 0.15s ease",
            }}
          />
        </div>

        <div>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "6px",
          }}>
            <label style={{
              fontSize: "12.5px",
              fontWeight: 500,
              color: "var(--fg-2, #b8b8cc)",
            }}>
              Password
            </label>
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            required
            className="mono"
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: "6px",
              background: "var(--bg-2, #181822)",
              border: "1px solid var(--line-soft, #2b2b3b)",
              color: "var(--fg, #f4f4f6)",
              fontSize: "13.5px",
              outline: "none",
              transition: "border-color 0.15s ease",
            }}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="btn btn-violet"
          style={{
            width: "100%",
            padding: "11px 16px",
            marginTop: "8px",
            fontSize: "14px",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Authenticating..." : "Sign In to Dashboard →"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div style={{
      minHeight: "80vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      width: "100%",
    }}>
      <Suspense fallback={
        <div style={{ color: "var(--fg-3)", fontSize: "14px" }}>Loading portal...</div>
      }>
        <LoginForm />
      </Suspense>
    </div>
  );
}
