import type { SVGProps } from "react";

const base = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type IconProps = SVGProps<SVGSVGElement>;

export const IconGrid = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);

export const IconChart = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 19V10" /><path d="M11 19V5" /><path d="M18 19v-7" /><path d="M3 19h18" /></svg>
);

export const IconPlug = (p: IconProps) => (
  <svg {...base} {...p}><path d="M9 2v4" /><path d="M15 2v4" /><path d="M6 9h12v3a6 6 0 0 1-12 0Z" /><path d="M12 18v4" /></svg>
);

export const IconPuzzle = (p: IconProps) => (
  <svg {...base} {...p}><path d="M9 3h4a1 1 0 0 1 1 1v2.2a1.8 1.8 0 0 0 3 1.34A1.8 1.8 0 0 1 20 9v4a1 1 0 0 1-1 1h-2.2a1.8 1.8 0 0 0 0 3.6V20a1 1 0 0 1-1 1H12a1.8 1.8 0 0 0-3.6 0H6a1 1 0 0 1-1-1v-4a1.8 1.8 0 0 0 0-3.6V9a1 1 0 0 1 1-1h2.2A1.8 1.8 0 0 0 8 4.34V4a1 1 0 0 1 1-1Z" /></svg>
);

export const IconShuffle = (p: IconProps) => (
  <svg {...base} {...p}><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" /></svg>
);

export const IconDatabase = (p: IconProps) => (
  <svg {...base} {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></svg>
);

export const IconShield = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4Z" /><path d="m9 12 2 2 4-4" /></svg>
);

export const IconUsers = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20c0-3.6 2.9-6.2 6.5-6.2s6.5 2.6 6.5 6.2" /><circle cx="17.5" cy="8.5" r="2.6" /><path d="M15.2 13.6c2.9.4 5.3 2.7 5.3 5.9" /></svg>
);

export const IconKey = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="7.5" cy="15.5" r="4.5" /><path d="m11 12 8-8" /><path d="M17 6l2 2" /><path d="M14 9l2 2" /></svg>
);

export const IconGear = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
);

export const IconBell = (p: IconProps) => (
  <svg {...base} {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
);

export const IconSearch = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <svg {...base} {...p}><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
);

export const IconSun = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.5" /><path d="M12 19.5V22" /><path d="M4.9 4.9l1.8 1.8" /><path d="M17.3 17.3l1.8 1.8" /><path d="M2 12h2.5" /><path d="M19.5 12H22" /><path d="M4.9 19.1l1.8-1.8" /><path d="M17.3 6.7l1.8-1.8" /></svg>
);

export const IconList = (p: IconProps) => (
  <svg {...base} {...p}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>
);

export const IconGavel = (p: IconProps) => (
  <svg {...base} {...p}><path d="m14 6 6 6" /><path d="m3.5 21 6-6" /><path d="M11 8 4 15l4 4 7-7" /><path d="m17 3 4 4-3 3-4-4Z" /><path d="M13 13l4-4" /></svg>
);

export const IconTag = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12.5 3H5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 .59 1.41l9.5 9.5a2 2 0 0 0 2.82 0l6.09-6.09a2 2 0 0 0 0-2.82l-9.5-9.5A2 2 0 0 0 12.5 3Z" /><circle cx="8.5" cy="8.5" r="1.4" /></svg>
);

export const IconReceipt = (p: IconProps) => (
  <svg {...base} {...p}><path d="M6 2h12v20l-2.5-1.5L13 22l-1-1.5L11 22l-2.5-1.5L6 22Z" /><path d="M9 7h6" /><path d="M9 11h6" /><path d="M9 15h4" /></svg>
);

export const IconRuler = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M7 7v3" /><path d="M11 7v3" /><path d="M15 7v3" /><path d="M19 7v3" /></svg>
);

export const IconTrendingUp = (p: IconProps) => (
  <svg {...base} {...p}><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
);

export const IconTarget = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></svg>
);

export const IconColumns = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3" y="3" width="7" height="18" rx="1.2" /><rect x="14" y="3" width="7" height="18" rx="1.2" /></svg>
);

export const IconFlask = (p: IconProps) => (
  <svg {...base} {...p}><path d="M9 2h6" /><path d="M10 2v6.2L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 8.2V2" /><path d="M7.5 15h9" /></svg>
);

export const IconPresentation = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M12 16v4" /><path d="M8 20h8" /><path d="M7 9l3 3 2-2 3.5 3.5" /></svg>
);

export const IconRocket = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z" /><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 19 2c0 2.52-.6 6.7-4 10a22 22 0 0 1-3.95 2Z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>
);

export const IconMoon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
);

export const IconHelp = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M9.2 9a2.8 2.8 0 1 1 3.8 2.6c-.8.35-1 .9-1 1.9" /><path d="M12 17h.01" /></svg>
);

export const IconChevronDown = (p: IconProps) => (
  <svg {...base} {...p}><path d="m6 9 6 6 6-6" /></svg>
);
