import { NextResponse } from "next/server";
import { saveIngestedShadowAi } from "@/lib/ingest";
import type { ShadowAiEvent } from "@/lib/types";

// POST /api/shadow-ai/scan  — called by the Prompt 10 expense scanner.
// Body: { events: ShadowAiEvent[] }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { events?: ShadowAiEvent[] };
    const events = Array.isArray(body.events) ? body.events : [];
    saveIngestedShadowAi(events);
    return NextResponse.json({ ok: true, count: events.length });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 400 },
    );
  }
}

// GET /api/shadow-ai/scan — return currently ingested findings.
export async function GET() {
  const { loadIngestedShadowAi } = await import("@/lib/ingest");
  return NextResponse.json(loadIngestedShadowAi());
}
