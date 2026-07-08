import { NextResponse } from "next/server";
import { getProviderBreakdown } from "@/lib/mock-data";

// GET /api/providers — spend by provider (pie chart source).
export async function GET() {
  return NextResponse.json(getProviderBreakdown());
}
