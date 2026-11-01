import { NextResponse } from "next/server";
import Tokenistt from "@tokenistt/sdk";
import {
  BENCHMARK_MODELS,
} from "@/lib/benchmark-data";
import { scoreAccuracy, scoreQuality } from "@/lib/benchmark-score";

export const runtime = "nodejs";
export const maxDuration = 300; // allow slow multi-model evals

type Prompt = { prompt: string; expected: string };

// POST /api/benchmark/run
// Body: { models: string[], prompts?: Prompt[], baseURL?: string, apiKey?: string }
// Runs the dataset across the selected models through the Tokenistt gateway
// (Prompt 3 SDK). Requires an uploaded dataset and a configured gateway/key.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      models?: string[];
      prompts?: Prompt[];
      baseURL?: string;
      apiKey?: string;
    };

    const models = body.models ?? [];
    const prompts: Prompt[] = Array.isArray(body.prompts) ? body.prompts : [];

    const baseURL = body.baseURL || process.env.TOKENISTT_BASE_URL || "";
    const apiKey = body.apiKey || process.env.TOKENISTT_API_KEY || "";

    if (models.length === 0) {
      return NextResponse.json({ error: "No models selected." }, { status: 400 });
    }

    if (prompts.length === 0) {
      return NextResponse.json({ error: "Upload a prompt dataset (CSV) to run a benchmark." }, { status: 400 });
    }

    if (!baseURL || !apiKey) {
      return NextResponse.json(
        { error: "Gateway not configured. Set TOKENISTT_BASE_URL and TOKENISTT_API_KEY." },
        { status: 400 },
      );
    }

    // ---- Live evaluation through the Tokenistt gateway (Prompt 3 SDK) ----
    const out = [];
    for (const id of models) {
      const profile = BENCHMARK_MODELS.find((m) => m.id === id);
      if (!profile) continue;

      const client = new Tokenistt({
        apiKey,
        baseURL,
        onUsage: (c: number) => {
          cost += c;
        },
      });
      let cost = 0;
      let correct = 0;
      let latSum = 0;
      let qSum = 0;

      for (const p of prompts) {
        const t0 = Date.now();
        const res = await client.chat.completions.create(
          {
            model: id,
            messages: [{ role: "user", content: p.prompt }],
          },
          {
            user: "benchmark",
            costCenter: "benchmark",
          }
        );
        latSum += Date.now() - t0;

        const text = res?.choices?.[0]?.message?.content ?? "";
        correct += scoreAccuracy(text, p.expected);
        qSum += scoreQuality(text, p.expected);
      }

      const n = prompts.length;
      out.push({
        id,
        label: profile.label,
        color: profile.color,
        costPerRequest: cost / n,
        totalCost: cost,
        accuracy: correct / n,
        latencyMs: Math.round(latSum / n),
        quality: Math.round((qSum / n) * 10) / 10,
      });
    }

    return NextResponse.json({ mode: "live", results: out });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Evaluation failed." },
      { status: 500 },
    );
  }
}
