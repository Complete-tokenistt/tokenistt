import type { Metadata } from "next";
import "./globals.css";
import "./dashboard-theme.css";
import DashboardShell from "@/components/DashboardShell";

export const metadata: Metadata = {
  title: "Tokenistt · Dashboard",
  description: "AI cost visibility and governance across every provider.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <DashboardShell>{children}</DashboardShell>
      </body>
    </html>
  );
}
