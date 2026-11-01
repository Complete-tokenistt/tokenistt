import { NextResponse } from "next/server";

export function dbUnavailable() {
  return NextResponse.json({ error: { message: "Database unavailable" } }, { status: 503 });
}
