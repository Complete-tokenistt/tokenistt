import { NextResponse } from "next/server";
import { getShadowAi } from "@/lib/mock-data";

// GET /api/shadow-ai — unauthorized-usage detections from expense integrations.
export async function GET() {
  return NextResponse.json(getShadowAi());
}
