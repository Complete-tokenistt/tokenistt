/**
 * GET /api/providers
 *
 * Returns the spend breakdown by provider for the current calendar month:
 *   - provider: provider key (openai, anthropic, bedrock, etc.)
 *   - label: formatted provider name
 *   - spendUsd: total cost_usd for this provider
 *   - sharePct: percentage of total spend
 *   - color: hex color code for visualization
 */

import { NextRequest, NextResponse } from "next/server";
import { dbUnavailable } from "@/lib/db-unavailable";
import { getPool } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";
import { PROVIDER_COLORS, PROVIDER_LABELS } from "@/lib/format";
import type { Provider } from "@/lib/types";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  // No DB configured───────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) return dbUnavailable();

  try {
    const pool = getPool();
    const orgId = session.orgId;

    const [totalRes, spendRes] = await Promise.all([
      // 1. Total spend for percentage calculation
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM   transactions
        WHERE  organization_id = $1
          AND  status = 'success'
          AND  created_at >= date_trunc('month', now())
      `, [orgId]),
      // 2. Spend grouped by provider
      pool.query<{ provider: string; spend: string }>(`
        SELECT provider,
               SUM(cost_usd)::text AS spend
        FROM   transactions
        WHERE  organization_id = $1
          AND  status = 'success'
          AND  created_at >= date_trunc('month', now())
        GROUP  BY provider
        ORDER  BY SUM(cost_usd) DESC
      `, [orgId]),
    ]);

    const totalSpend = parseFloat(totalRes.rows[0]?.total || "0");

    const rows = spendRes.rows.map((r) => {
      const providerKey = r.provider.toLowerCase() as Provider;
      const spendUsd = parseFloat(r.spend);
      const sharePct = totalSpend > 0 ? (spendUsd / totalSpend) * 100 : 0;

      return {
        provider: providerKey,
        label: PROVIDER_LABELS[providerKey] ?? r.provider,
        spendUsd,
        sharePct,
        color: PROVIDER_COLORS[providerKey] ?? PROVIDER_COLORS.other,
      };
    });

    return NextResponse.json(rows);
  } catch (err: any) {
    console.error("[/api/providers] DB error:", err.message);
    return dbUnavailable();
  }
}

/**
 * POST /api/providers
 * Body: { provider: string, apiKey: string, baseUrl?: string, action?: "validate" | "connect" }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { provider, apiKey, baseUrl, action = "connect" } = body;

    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: "Provider and apiKey are required" },
        { status: 400 }
      );
    }

    const gatewayUrl =
      process.env.GATEWAY_URL ||
      process.env.NEXT_PUBLIC_GATEWAY_URL ||
      "http://localhost:4000";

    const targetEndpoint =
      action === "validate"
        ? `${gatewayUrl}/v1/providers/validate`
        : `${gatewayUrl}/v1/providers/connect`;

    try {
      const gwRes = await fetch(targetEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider, apiKey, baseUrl }),
        signal: AbortSignal.timeout(12000),
      });

      const data = await gwRes.json();
      return NextResponse.json(data, { status: gwRes.status });
    } catch (gwErr: any) {
      console.warn(
        `[/api/providers] Gateway at ${gatewayUrl} unreachable (${gwErr.message}). Falling back to local check.`
      );

      // Local fallback if gateway is temporarily down
      const effectiveBaseUrl =
        baseUrl ||
        (provider.toLowerCase() === "groq"
          ? "https://api.groq.com/openai/v1"
          : provider.toLowerCase() === "together"
          ? "https://api.together.xyz/v1"
          : provider.toLowerCase() === "mistral"
          ? "https://api.mistral.ai/v1"
          : "https://api.openai.com/v1");

      const startTime = Date.now();
      try {
        const pingRes = await fetch(`${effectiveBaseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        });

        const latency_ms = Date.now() - startTime;
        if (!pingRes.ok) {
          const errData = await pingRes.json().catch(() => ({}));
          return NextResponse.json(
            {
              valid: false,
              error:
                errData.error?.message ||
                `Upstream authentication failed (${pingRes.status})`,
            },
            { status: 400 }
          );
        }

        return NextResponse.json({
          success: true,
          valid: true,
          provider: provider.toLowerCase(),
          latency_ms,
          raw_token: `tktt_live_org1_${provider.toLowerCase()}_live`,
          key_prefix: `tktt_live_org1_${provider.toLowerCase()}...`,
        });
      } catch (pingErr: any) {
        return NextResponse.json(
          { valid: false, error: pingErr.message },
          { status: 400 }
        );
      }
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

