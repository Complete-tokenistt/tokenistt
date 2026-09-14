import { NextRequest, NextResponse } from "next/server";
import { getPool, isDbAvailable } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const searchParams = req.nextUrl.searchParams;
  const range = searchParams.get("range") || "24h";
  const team = searchParams.get("team");
  const provider = searchParams.get("provider");
  const status = searchParams.get("status");

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    return NextResponse.json({ requests: [], count: 0, totalCost: 0 });
  }

  try {
    const pool = getPool();

    let interval = "'24 hours'";
    if (range === "1h") interval = "'1 hour'";
    if (range === "7d") interval = "'7 days'";
    if (range === "30d") interval = "'30 days'";

    const conditions: string[] = [
      "organization_id = $1",
      `created_at >= now() - interval ${interval}`,
    ];
    const params: any[] = [session.orgId];
    let pIdx = 2;

    if (team && team !== "all") {
      conditions.push(`cost_center = $${pIdx}`);
      params.push(team);
      pIdx++;
    }

    if (provider && provider !== "all") {
      conditions.push(`LOWER(provider) = LOWER($${pIdx})`);
      params.push(provider);
      pIdx++;
    }

    if (status && status !== "all") {
      conditions.push(`status = $${pIdx}`);
      params.push(status);
      pIdx++;
    }

    const whereClause = conditions.join(" AND ");

    const { rows } = await pool.query<{
      id: string;
      request_id: string;
      provider: string;
      model: string;
      endpoint: string;
      cost_usd: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      duration_ms: number;
      status: string;
      cost_center: string | null;
      project_tag: string | null;
      actor: string | null;
      created_at: string;
    }>(
      `
      SELECT 
        id::text,
        request_id,
        provider,
        model,
        endpoint,
        cost_usd::text,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        duration_ms,
        status,
        cost_center,
        project_tag,
        actor,
        created_at::text
      FROM transactions
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT 100
      `,
      params
    );

    const requests = rows.map((r) => ({
      id: r.request_id || r.id,
      timestamp: r.created_at,
      time: new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      team: r.cost_center || "general",
      project: r.project_tag || "default",
      provider: r.provider,
      model: r.model,
      tokens: r.total_tokens || 0,
      inputTokens: r.prompt_tokens || 0,
      outputTokens: r.completion_tokens || 0,
      latency: `${Math.round(r.duration_ms)}ms`,
      durationMs: r.duration_ms,
      status: r.status === "success" ? "success" : r.status === "rate_limited" ? "throttled" : "error",
      cost: parseFloat(r.cost_usd || "0"),
      actor: r.actor || "user",
    }));

    const totalCost = requests.reduce((acc, r) => acc + r.cost, 0);

    return NextResponse.json({
      requests,
      count: requests.length,
      totalCost: Math.round(totalCost * 10000) / 10000,
    });
  } catch (err: any) {
    console.error("[/api/usage] DB error:", err.message);
    return NextResponse.json({ requests: [], count: 0, totalCost: 0 });
  }
}

