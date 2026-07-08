import { NextResponse } from "next/server";
import { getSummary } from "@/lib/mock-data";

// GET /api/summary — Executive Summary KPIs.
export async function GET() {
  return NextResponse.json(getSummary());
}
