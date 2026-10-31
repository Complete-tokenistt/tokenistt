"use client";

import { useRef, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  BENCHMARK_MODELS,
  SAMPLE_CSV,
  SAMPLE_PROMPTS,
  recommendId,
  type BenchmarkResult,
} from "@/lib/benchmark-data";
import { fmtUsd } from "@/lib/format";
import Section from "./Section";
import ProgressBar from "./ProgressBar";
import Badge from "./Badge";
import { DataTable } from "./DataTable";

type Prompt = { prompt: string; expected: string };
type Mode = "live" | "simulated" | null;

export default function BenchmarkClient() {
  const [prompts, setPrompts] = useState<Prompt[]>(SAMPLE_PROMPTS);
  const [datasetLabel, setDatasetLabel] = useState(
    `Sample dataset (${SAMPLE_PROMPTS.length} prompts)`,
  );
  const [selected, setSelected] = useState<string[]>([
    "gpt-4o",
    "claude-3-5-sonnet",
    "gpt-4o-mini",
    "claude-3-haiku",
  ]);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [results, setResults] = useState<BenchmarkResult[] | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [recommendedId, setRecommendedId] = useState<string | null>(null);
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function parseDataset(text: string): Prompt[] {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return [];
    const delim = lines[0].includes("\t")
      ? "\t"
      : lines[0].includes(";")
        ? ";"
        : ",";
    const headers = lines[0].split(delim).map((h) => h.trim().toLowerCase());
    const iPrompt = headers.findIndex((h) => h.includes("prompt"));
    const iExpected = headers.findIndex(
      (h) =>
        h.includes("expected") || h.includes("output") || h.includes("answer"),
    );
    if (iPrompt < 0 || iExpected < 0) return [];
    const out: Prompt[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim);
      const p = cols[iPrompt]?.trim();
      const e = cols[iExpected]?.trim();
      if (p && e) out.push({ prompt: p, expected: e });
    }
    return out;
  }

  async function handleFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseDataset(text);
      if (parsed.length === 0)
        throw new Error("No valid prompt/expected rows found.");
      setPrompts(parsed);
      setDatasetLabel(`${file.name} (${parsed.length} prompts)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    }
  }

  function toggleModel(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  // Runs the eval on the server (live via gateway, or simulated fallback).
  // The progress bar animates during the (possibly long) request.
  async function runEval() {
    if (selected.length === 0 || running) return;
    setRunning(true);
    setProgress(0);
    setResults(null);
    setRecommendedId(null);
    setSwitchedTo(null);
    setError(null);
    setMode(null);

    const total = prompts.length;
    const timer = setInterval(() => {
      setProgress((p) => Math.min(p + (92 - p) * 0.06 + 1.5, 93));
    }, 150);

    try {
      const res = await fetch("/api/benchmark/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models: selected,
          prompts,
          baseURL: gatewayUrl || undefined,
          apiKey: apiKey || undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(err?.error ?? "Evaluation failed");
      }
      const data = (await res.json()) as {
        mode: Mode;
        results: BenchmarkResult[];
      };
      setResults(data.results);
      setMode(data.mode);
      setRecommendedId(recommendId(data.results));
      setStatus(`Evaluated ${total} prompts × ${selected.length} models`);
      setProgress(100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evaluation failed");
    } finally {
      clearInterval(timer);
      setRunning(false);
    }
  }

  const columns: ColumnDef<BenchmarkResult, unknown>[] = [
    {
      accessorKey: "label",
      header: "Model",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: row.original.color }}
          />
          <span className="font-medium" style={{ color: "var(--fg)" }}>{row.original.label}</span>
        </div>
      ),
    },
    {
      accessorKey: "costPerRequest",
      header: "Cost / request",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg)" }}>
          ${getValue<number>().toFixed(4)}
        </span>
      ),
    },
    {
      id: "total",
      header: `Total cost (${prompts.length})`,
      cell: ({ row }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg-2)" }}>
          {fmtUsd(row.original.costPerRequest * prompts.length, 2)}
        </span>
      ),
    },
    {
      accessorKey: "accuracy",
      header: "Accuracy",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg)" }}>
          {(getValue<number>() * 100).toFixed(1)}%
        </span>
      ),
    },
    {
      accessorKey: "latencyMs",
      header: "Latency",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg-3)" }}>
          {getValue<number>()} ms
        </span>
      ),
    },
    {
      accessorKey: "quality",
      header: "Quality",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg)" }}>{getValue<number>().toFixed(1)}/10</span>
      ),
    },
    {
      id: "rec",
      header: "",
      cell: ({ row }) =>
        row.original.id === recommendedId ? (
          <Badge tone="emerald">Recommended</Badge>
        ) : null,
    },
    {
      id: "action",
      header: "",
      cell: ({ row }) => {
        const isRec = row.original.id === recommendedId;
        return (
          <button
            onClick={() => {
              setRecommendedId(row.original.id);
              setSwitchedTo(row.original.label);
            }}
            disabled={isRec}
            className={
              isRec
                ? "rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200"
                : "rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700"
            }
          >
            {isRec ? "✓ Active" : "Switch to this model"}
          </button>
        );
      },
    },
  ];

  const recommendedLabel = results?.find((r) => r.id === recommendedId)?.label;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Model Benchmarking (A/B)</h2>
        <p className="text-xs mono" style={{ color: "var(--fg-4)" }}>
          Compare model performance across providers before you commit
        </p>
      </div>

      {/* 1. Dataset */}
      <Section
        title="1 · Test dataset"
        description="Upload a CSV with prompt + expected output"
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => fileRef.current?.click()}
            className="btn btn-violet btn-sm"
          >
            Upload dataset (CSV)
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
          <span className="text-xs mono" style={{ color: "var(--fg-3)" }}>{datasetLabel}</span>
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
            download="sample-benchmark.csv"
            className="ml-auto text-xs mono font-medium hover:underline"
            style={{ color: "var(--violet)" }}
          >
            Download sample CSV
          </a>
        </div>
        {error && <p className="mt-2 text-xs mono" style={{ color: "var(--red)" }}>{error}</p>}
      </Section>

      {/* 2. Model selection */}
      <Section
        title="2 · Models to compare"
        description="Select two or more models"
      >
        <div className="flex flex-wrap gap-2">
          {BENCHMARK_MODELS.map((m) => {
            const on = selected.includes(m.id);
            return (
              <button
                key={m.id}
                onClick={() => toggleModel(m.id)}
                className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition mono"
                style={{
                  background: on ? "var(--violet-glow)" : "var(--bg-2)",
                  color: on ? "var(--fg)" : "var(--fg-3)",
                  border: `1px solid ${on ? "var(--violet)" : "var(--line-soft)"}`,
                }}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: m.color }}
                />
                {m.label}
              </button>
            );
          })}
        </div>
      </Section>

      {/* 3. Gateway settings + run */}
      <Section
        title="3 · Run evaluation"
        description="Runs live via the Tokenistt gateway when configured, else simulated"
      >
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs mono" style={{ color: "var(--fg-4)" }}>
            Gateway URL (optional)
            <input
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder="https://gateway.internal/v1"
              className="mt-1 w-full rounded-md px-2 py-1.5 text-sm mono"
              style={{
                background: "var(--bg-3)",
                color: "var(--fg)",
                border: "1px solid var(--line)",
              }}
            />
          </label>
          <label className="text-xs mono" style={{ color: "var(--fg-4)" }}>
            API key (optional)
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="tk_live_…"
              className="mt-1 w-full rounded-md px-2 py-1.5 text-sm mono"
              style={{
                background: "var(--bg-3)",
                color: "var(--fg)",
                border: "1px solid var(--line)",
              }}
            />
          </label>
        </div>

        <button
          onClick={runEval}
          disabled={selected.length === 0 || running}
          className="btn btn-violet btn-sm disabled:opacity-60"
        >
          {running ? "Running…" : "Run evaluation"}
        </button>

        {(running || progress > 0) && (
          <div className="mt-4 max-w-xl">
            <ProgressBar valuePct={progress} tone={running ? "brand" : "emerald"} />
            <p className="mt-1 text-xs mono" style={{ color: "var(--fg-3)" }}>{status}</p>
          </div>
        )}
      </Section>

      {/* 4. Results */}
      {results && (
        <Section
          title="4 · Results"
          description="Cost, accuracy, latency, quality"
        >
          {mode === "live" ? (
            <div
              className="card p-3 mb-3 text-sm"
              style={{
                background: "oklch(0.760 0.150 155 / 0.12)",
                borderColor: "var(--green)",
                color: "var(--green)",
              }}
            >
              Live evaluation via the Tokenistt gateway. Recommendation: switch
              to <strong>{recommendedLabel}</strong> — best quality-per-cost
              among accurate models.
            </div>
          ) : (
            <div
              className="card p-3 mb-3 text-sm"
              style={{
                background: "oklch(0.800 0.150 80 / 0.12)",
                borderColor: "var(--amber)",
                color: "var(--amber)",
              }}
            >
              Simulated results (no gateway configured). Set{" "}
              <code
                className="rounded px-1"
                style={{ background: "oklch(0.800 0.150 80 / 0.2)" }}
              >
                TOKENISTT_BASE_URL
              </code>{" "}
              +{" "}
              <code
                className="rounded px-1"
                style={{ background: "oklch(0.800 0.150 80 / 0.2)" }}
              >
                TOKENISTT_API_KEY
              </code>{" "}
              (or enter them above) to run live. Recommendation:{" "}
              <strong>{recommendedLabel}</strong>.
            </div>
          )}
          <DataTable columns={columns} data={results} />
          {switchedTo && (
            <p className="mt-3 text-xs mono" style={{ color: "var(--fg-3)" }}>
              Active model set to <strong>{switchedTo}</strong> (local state —
              would persist to the gateway in production).
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
