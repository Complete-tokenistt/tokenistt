import { NextResponse } from "next/server";
import { getAnomalies } from "@/lib/mock-data";

// GET /api/anomalies — spend-anomaly alerts (>3x 30-day avg).
export async function GET() {
  return NextResponse.json(getAnomalies());
}
