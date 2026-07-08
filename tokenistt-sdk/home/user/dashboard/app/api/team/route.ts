import { NextResponse } from "next/server";
import { getTeamView } from "@/lib/mock-data";

// GET /api/team — Team Manager View data (team-scoped).
export async function GET() {
  return NextResponse.json(getTeamView());
}
