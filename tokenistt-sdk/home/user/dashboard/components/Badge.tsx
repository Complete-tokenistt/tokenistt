import { statusTone } from "@/lib/format";

export default function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: string; // optional override; falls back to statusTone(children text)
}) {
  const cls = tone ? statusTone(tone) : statusTone(String(children));
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {children}
    </span>
  );
}
