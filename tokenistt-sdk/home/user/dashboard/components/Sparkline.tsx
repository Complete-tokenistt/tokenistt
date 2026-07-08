"use client";

// Ported from tokenistt marketing-site (Primitives.jsx) — Sparkline + NumTicker.

import { useEffect, useRef, useState } from "react";

export function useTween(target: number, duration = 700) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    const to = target;
    if (from === to) return;
    let raf: number;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

export function NumTicker({ value, decimals = 0, prefix = "", suffix = "" }: { value: number; decimals?: number; prefix?: string; suffix?: string }) {
  const v = useTween(value);
  const formatted = v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <span className="mono">{prefix}{formatted}{suffix}</span>;
}

export function Sparkline({
  data,
  width = 200,
  height = 60,
  stroke = "var(--violet)",
  fill = "var(--violet-glow)",
  showFill = true,
  strokeWidth = 1.4,
  pad = 4,
  showDot = true,
  responsive = false,
}: {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  showFill?: boolean;
  strokeWidth?: number;
  pad?: number;
  showDot?: boolean;
  responsive?: boolean;
}) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => (i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`)).join(" ");
  const dArea = `${d} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  const last = pts[pts.length - 1];
  const svgInner = (
    <>
      {showFill && <path d={dArea} fill={fill} />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      {showDot && (
        <g>
          <circle cx={last[0]} cy={last[1]} r={6} fill={stroke} opacity={0.18} />
          <circle cx={last[0]} cy={last[1]} r={2.5} fill={stroke} />
        </g>
      )}
    </>
  );
  if (responsive) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }}>
        {svgInner}
      </svg>
    );
  }
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {svgInner}
    </svg>
  );
}
