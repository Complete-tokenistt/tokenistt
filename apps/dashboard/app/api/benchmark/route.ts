import { NextResponse } from "next/server";
import { BENCHMARK_MODELS } from "@/lib/benchmark-data";

// GET /api/benchmark — selectable models (id, label, color) for the benchmarking UI.
export async function GET() {
  return NextResponse.json({ models: BENCHMARK_MODELS.map(({ id, label, color }) => ({ id, label, color })) });
}
