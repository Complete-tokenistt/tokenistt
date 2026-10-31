"use client";

import { useCallback, useEffect, useState } from "react";

export type TourStep = { target: string | null; title: string; body: string };

export default function Tour({ steps, onFinish }: { steps: TourStep[]; onFinish: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[index];

  const measure = useCallback(() => {
    if (!step?.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(step.target);
    if (!el) {
      setRect(null);
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setRect(el.getBoundingClientRect());
  }, [step]);

  useEffect(() => {
    measure();
    const t = setTimeout(measure, 260);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  function next() {
    if (index < steps.length - 1) setIndex((i) => i + 1);
    else onFinish();
  }
  function back() {
    setIndex((i) => Math.max(0, i - 1));
  }

  if (!step) return null;

  const pad = 8;
  const spotStyle: React.CSSProperties = rect
    ? {
        position: "fixed",
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        borderRadius: 10,
        boxShadow: "0 0 0 9999px oklch(0 0 0 / 0.7)",
        border: "1.5px solid var(--violet)",
        zIndex: 300,
        pointerEvents: "none",
        transition: "top 0.22s ease, left 0.22s ease, width 0.22s ease, height 0.22s ease",
      }
    : { position: "fixed", inset: 0, background: "oklch(0 0 0 / 0.7)", zIndex: 300 };

  let tipStyle: React.CSSProperties = { position: "fixed", zIndex: 301, width: 340 };
  if (rect && typeof window !== "undefined") {
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeBelow = spaceBelow > 210;
    const top = placeBelow ? rect.bottom + pad + 12 : Math.max(16, rect.top - 12 - 200);
    const left = Math.min(Math.max(16, rect.left), window.innerWidth - 356);
    tipStyle = { ...tipStyle, top, left };
  } else {
    tipStyle = { ...tipStyle, top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }

  return (
    <>
      <div style={spotStyle} />
      <div className="card dash-tour-card" style={tipStyle} onClick={(e) => e.stopPropagation()}>
        <div className="dash-tour-head">
          <span className="mono dash-tour-step">STEP {index + 1} / {steps.length}</span>
          <button type="button" className="dash-tour-close" onClick={onFinish} aria-label="Close tour">×</button>
        </div>
        <h3 className="dash-tour-title">{step.title}</h3>
        <p className="dash-tour-body">{step.body}</p>
        <div className="dash-tour-dots">
          {steps.map((_, i) => (
            <span key={i} className={`dash-tour-dot${i === index ? " active" : ""}`} />
          ))}
        </div>
        <div className="dash-tour-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onFinish}>Skip</button>
          <div style={{ display: "flex", gap: 8 }}>
            {index > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={back}>Back</button>}
            <button type="button" className="btn btn-violet btn-sm" onClick={next}>
              {index < steps.length - 1 ? "Next →" : "Done"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
