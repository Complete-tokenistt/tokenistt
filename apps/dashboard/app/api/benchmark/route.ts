import { NextResponse } from "next/server";
import { BENCHMARK_MODELS } from "@/lib/benchmark-data";

// GET /api/benchmark — available models + profiles for the benchmarking UI.
export async function GET() {
  return NextResponse.json({ models: BENCHMARK_MODELS });
}
