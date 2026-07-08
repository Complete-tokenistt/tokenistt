import { NextResponse } from "next/server";
import { getCostCenters } from "@/lib/mock-data";

// GET /api/cost-centers — cost-center drill-down rows.
export async function GET() {
  return NextResponse.json(getCostCenters());
}
