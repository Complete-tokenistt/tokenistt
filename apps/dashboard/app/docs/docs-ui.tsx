"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const THEME_KEY = "tokenistt-dash-theme";

export type NavGroup = { group: string; items: [string, string][] };

/** Copyable code block. */
export function Code({ children, lang = "bash" }: { children: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="dcode">
      <div className="dcode-bar">
        <span className="dcode-lang mono">{lang}</span>
        <button type="button" className="dcode-copy mono" onClick={copy} aria-label="Copy code">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="dscroll">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Callout({ kind = "info", title, children }: { kind?: "info" | "warn" | "ok"; title: string; children: ReactNode }) {
  const icon = kind === "warn" ? "!" : kind === "ok" ? "✓" : "i";
  return (
    <div className={`dcallout dcallout-${kind}`}>
      <span className="dcallout-icon mono">{icon}</span>
      <div>
        <div className="dcallout-title">{title}</div>
        <div className="dcallout-body">{children}</div>
      </div>
    </div>
  );
}

export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="dstep">
      <div className="dstep-n mono">{n}</div>
      <div className="dstep-body">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Sidebar + scroll container with scroll-spy, progress bar and theme toggle. */
export function DocsFrame({ nav, children }: { nav: NavGroup[]; children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(nav[0].items[0][0]);
  const [progress, setProgress] = useState(0);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".dash-shell");
    setTheme(shell?.dataset.theme === "light" ? "light" : "dark");
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.querySelector<HTMLElement>(".dash-shell")?.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable */
    }
  }

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const ids = nav.flatMap((g) => g.items.map(([id]) => id));
    const onScroll = () => {
      const max = root.scrollHeight - root.clientHeight;
      setProgress(max > 0 ? (root.scrollTop / max) * 100 : 0);
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - root.getBoundingClientRect().top <= 120) current = id;
      }
      setActive(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [nav]);

  function go(id: string) {
    setOpen(false);
    const el = document.getElementById(id);
    const root = scrollRef.current;
    if (el && root) {
      root.scrollTo({ top: el.offsetTop - 24, behavior: "smooth" });
      history.replaceState(null, "", `#${id}`);
    }
  }

  return (
    <div className="docs">
      <div className="docs-progress" style={{ width: `${progress}%` }} />
      <button type="button" className="docs-burger mono" onClick={() => setOpen((v) => !v)} aria-label="Toggle navigation">
        {open ? "✕ Close" : "☰ Menu"}
      </button>

      <aside className={`docs-nav dscroll${open ? " is-open" : ""}`} aria-label="Documentation">
        <a className="docs-brand" href="/docs">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" width={26} height={26} />
          <span>Tokenistt</span>
          <span className="docs-pill mono">docs</span>
        </a>
        {nav.map((g) => (
          <div key={g.group} className="docs-group">
            <div className="docs-group-title mono">{g.group}</div>
            {g.items.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className={`docs-item${active === id ? " is-active" : ""}`}
                onClick={(e) => {
                  e.preventDefault();
                  go(id);
                }}
              >
                {label}
              </a>
            ))}
          </div>
        ))}
        <div className="docs-nav-foot">
          <a href="/" className="docs-back">← Back to dashboard</a>
          <button type="button" className="docs-theme mono" onClick={toggleTheme}>
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
        </div>
      </aside>

      <div className="docs-scroll dscroll" ref={scrollRef}>
        {children}
      </div>
    </div>
  );
}
