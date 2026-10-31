import type { ReactNode } from "react";

export default function Section({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`} style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15.5, color: "var(--fg)" }}>{title}</div>
          {description && (
            <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 3 }}>{description}</div>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
