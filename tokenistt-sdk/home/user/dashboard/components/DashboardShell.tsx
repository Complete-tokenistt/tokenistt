"use client";

// Ported from the tokenistt marketing-site dashboard preview
// (src/components/dashboard/DashboardLayout.jsx). Converted from
// react-router (NavLink/useLocation/Outlet) to Next.js (Link/usePathname),
// and Clerk's useUser() dropped — this app has no auth yet, so
// workspace/firstName are static placeholders instead of pulled from a
// signed-in user.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_GROUPS, SECTION_META } from "@/lib/navConfig";
import Tour from "@/components/Tour";
import { buildTourSteps } from "@/lib/tourSteps";
import { IconBell, IconHelp, IconMoon, IconRocket, IconSearch, IconSun } from "@/components/icons";

const THEME_KEY = "tokenistt-dash-theme";
const TOUR_SEEN_KEY = "tokenistt-dash-tour-seen";
const WORKSPACE = "workspace";
const FIRST_NAME = "there";

export type DashboardMode = "live" | "demo";

type DashboardCtx = {
  workspace: string;
  firstName: string;
  notify: (message: string) => void;
  mode: DashboardMode;
  setMode: (mode: DashboardMode) => void;
  isLive: boolean;
  user: { email: string; role: string } | null;
};
const DashboardContext = createContext<DashboardCtx>({
  workspace: WORKSPACE,
  firstName: FIRST_NAME,
  notify: () => {},
  mode: "live",
  setMode: () => {},
  isLive: true,
  user: null,
});
export const useDashboard = () => useContext(DashboardContext);

function getInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function DashboardShell({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(getInitialTheme);
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const [tourOpen, setTourOpen] = useState(false);
  const [mode, setModeState] = useState<DashboardMode>(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem("tokenistt_dash_mode") as DashboardMode;
      if (saved === "live" || saved === "demo") return saved;
    }
    return "live";
  });
  const pathname = usePathname();

  function setMode(newMode: DashboardMode) {
    setModeState(newMode);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("tokenistt_dash_mode", newMode);
    }
    notify(newMode === "live" ? "Switched to Live Organization Data" : "Switched to Demo Preview Showcase");
  }

  useEffect(() => {
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!window.localStorage.getItem(TOUR_SEEN_KEY)) {
      const t = setTimeout(() => setTourOpen(true), 500);
      return () => clearTimeout(t);
    }
  }, []);

  const safePathname = pathname ?? "/";
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.authenticated && data.user) {
          setUser(data.user);
        } else {
          setUser(null);
        }
      })
      .catch(() => {});
  }, [pathname]);

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      localStorage.removeItem("tokenistt_token");
      localStorage.removeItem("tokenistt_user");
      window.location.href = "/login";
    } catch {
      window.location.href = "/login";
    }
  }

  if (safePathname === "/login") {
    return (
      <DashboardContext.Provider value={{
        workspace: WORKSPACE,
        firstName: FIRST_NAME,
        notify,
        mode,
        setMode,
        isLive: mode === "live",
        user,
      }}>
        <div className="dash-shell" data-theme={theme} style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          {children}
        </div>
      </DashboardContext.Provider>
    );
  }

  const meta = SECTION_META[safePathname] || SECTION_META["/"];
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  function notify(message: string) {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }

  function closeTour() {
    setTourOpen(false);
    window.localStorage.setItem(TOUR_SEEN_KEY, "true");
  }

  return (
    <DashboardContext.Provider value={{
      workspace: user?.email ? user.email.split("@")[0] : WORKSPACE,
      firstName: user?.email ? user.email.split("@")[0] : FIRST_NAME,
      notify,
      mode,
      setMode,
      isLive: mode === "live",
      user,
    }}>
      <div className="dash-shell" data-theme={theme}>
        {mode === "demo" && (
          <div style={{
            background: "oklch(0.70 0.16 70 / 0.12)",
            borderBottom: "1px solid oklch(0.70 0.16 70 / 0.3)",
            padding: "6px 18px",
            fontSize: 12.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: "#d97706",
          }}>
            <span>
              <strong>Demo Preview Mode</strong> — Viewing sample enterprise showcase dataset ($26.6k spend, 4 anomalies). Your live company data is unaffected.
            </span>
            <button
              type="button"
              onClick={() => setMode("live")}
              style={{
                background: "transparent",
                border: "none",
                color: "#d97706",
                textDecoration: "underline",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              Switch to Live Data →
            </button>
          </div>
        )}
        <div className="dash-topbar">
          <div className="dash-topbar-inner">
            <button type="button" className="dash-mobile-toggle" onClick={() => setMobileNavOpen((v) => !v)} aria-label="Toggle navigation">
              <span /><span /><span />
            </button>

            <div className="dash-topbar-crumb" data-tour="tour-crumb">
              <span className="mono dash-topbar-workspace">{user?.email ? user.email.split("@")[0] : WORKSPACE}</span>
              <span className="dash-topbar-sep">/</span>
              <span className="mono dash-topbar-section">{meta.title}</span>
            </div>

            <div className="dash-topbar-search" data-tour="tour-search">
              <IconSearch />
              <input readOnly placeholder="Search requests, keys, teams… (⌘K)" />
            </div>

            <div className="dash-topbar-actions">
              {/* Live vs Demo Preview Switcher */}
              <div style={{ display: "flex", alignItems: "center", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 20, padding: "2px 4px" }}>
                <button
                  type="button"
                  onClick={() => setMode("live")}
                  style={{
                    padding: "3px 9px",
                    borderRadius: 14,
                    border: "none",
                    cursor: "pointer",
                    background: mode === "live" ? "oklch(0.65 0.18 145 / 0.18)" : "transparent",
                    color: mode === "live" ? "#22c55e" : "var(--fg-4)",
                    fontWeight: mode === "live" ? 600 : 400,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11.5,
                  }}
                  title="Live authentic data attached to your organization"
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: mode === "live" ? "#22c55e" : "var(--fg-4)" }} />
                  Live Data
                </button>
                <button
                  type="button"
                  onClick={() => setMode("demo")}
                  style={{
                    padding: "3px 9px",
                    borderRadius: 14,
                    border: "none",
                    cursor: "pointer",
                    background: mode === "demo" ? "oklch(0.70 0.16 70 / 0.18)" : "transparent",
                    color: mode === "demo" ? "#f59e0b" : "var(--fg-4)",
                    fontWeight: mode === "demo" ? 600 : 400,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11.5,
                  }}
                  title="Sample preview data for demonstration"
                >
                  👁 Demo
                </button>
              </div>

              {user ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="tag mono" style={{ color: "var(--violet)", background: "oklch(0.55 0.20 295 / 0.12)", border: "1px solid var(--line-soft)" }}>
                    {user.email} ({user.role})
                  </span>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="btn btn-ghost btn-sm mono"
                    style={{ fontSize: 12, padding: "4px 8px" }}
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <Link href="/login" className="btn btn-violet btn-sm">
                  Sign in
                </Link>
              )}
              <Link href="/onboarding" className="btn btn-ghost btn-sm" data-tour="tour-getstarted">
                <IconRocket />
                Onboarding
              </Link>
              <button type="button" className="dash-icon-btn" aria-label="Take a tour" title="Take a tour" onClick={() => setTourOpen(true)}>
                <IconHelp />
              </button>
              <button type="button" className="dash-icon-btn" aria-label="Notifications">
                <IconBell />
                <span className="dash-icon-dot" />
              </button>
              <button
                type="button"
                className="dash-theme-toggle"
                onClick={toggleTheme}
                aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
                title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
                data-tour="tour-theme"
              >
                {theme === "light" ? <IconMoon /> : <IconSun />}
              </button>
            </div>
          </div>
        </div>


        <div className="dash-body">
          <aside className={`dash-sidebar${mobileNavOpen ? " open" : ""}`}>
            <div className="dash-sidebar-scroll">
              {NAV_GROUPS.map((group) => (
                <div className="dash-nav-group" key={group.label} data-tour={`tour-group-${group.label}`}>
                  <div className="mono dash-nav-label">{group.label}</div>
                  {group.items.map((item) => {
                    const active = item.href === "/" ? safePathname === "/" : safePathname.startsWith(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`dash-nav-item${active ? " active" : ""}`}
                        onClick={() => setMobileNavOpen(false)}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="dash-sidebar-foot">
              <div className="dash-plan-card" data-tour="tour-plancard">
                <div className="mono" style={{ fontSize: 11.5, color: "var(--violet)", letterSpacing: "0.05em" }}>PHASE 1</div>
                <div style={{ fontSize: 13.5, color: "var(--fg-2)", marginTop: 4, lineHeight: 1.5 }}>
                  Governance, providers, cost centers, reconciliation, shadow AI, team, benchmark, and settings run on live data. The rest is preview data until wired up.
                </div>
                <button type="button" className="mono dash-link-btn" style={{ marginTop: 10 }} onClick={() => setTourOpen(true)}>
                  ↻ Retake the tour
                </button>
              </div>
            </div>
          </aside>

          {mobileNavOpen && <div className="dash-sidebar-backdrop" onClick={() => setMobileNavOpen(false)} />}

          <main className="dash-main">
            <div className="dash-page-head">
              <div className="eyebrow">
                <span className="num">{meta.kicker}</span>
                <span className="bar" />
                <span>tokenistt · {WORKSPACE}</span>
              </div>
              <div className="dash-page-head-row">
                <div>
                  <h1 className="dash-page-title">{safePathname === "/" ? <>Welcome back, {FIRST_NAME}</> : meta.title}</h1>
                  <p className="dash-page-desc">{meta.desc}</p>
                </div>
              </div>
            </div>

            {children}
          </main>
        </div>

        <div className="dash-toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className="dash-toast mono">✓ {t.message}</div>
          ))}
        </div>

        {tourOpen && <Tour steps={buildTourSteps()} onFinish={closeTour} />}
      </div>
    </DashboardContext.Provider>
  );
}
