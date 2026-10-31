// Benchmark / A/B testing data for the Chatbot Benchmarking UI (Prompt 9).
// Model profiles are deterministic; the "evaluation" is simulated client-side
// (no live provider calls in this scaffold). Swap `runEvaluation` for real
// gateway calls when wiring to production.

export interface ModelProfile {
  id: string;
  label: string;
  color: string;
  costPerRequest: number; // USD per request
  accuracy: number; // 0..1
  latencyMs: number;
  quality: number; // 0..10 (human/LLM-judge score)
}

export interface BenchmarkResult {
  id: string;
  label: string;
  color: string;
  costPerRequest: number;
  totalCost: number; // costPerRequest * promptCount
  accuracy: number; // 0..1
  latencyMs: number;
  quality: number; // 0..10
}

// Default per-model benchmark profiles (illustrative, deterministic).
export const BENCHMARK_MODELS: ModelProfile[] = [
  { id: "gpt-4o", label: "GPT-4o", color: "#ef4444", costPerRequest: 0.012, accuracy: 0.91, latencyMs: 820, quality: 8.7 },
  { id: "claude-3-5-sonnet", label: "Claude Sonnet", color: "#f59e0b", costPerRequest: 0.009, accuracy: 0.89, latencyMs: 910, quality: 8.9 },
  { id: "gpt-4o-mini", label: "GPT-4o-mini", color: "#10b981", costPerRequest: 0.002, accuracy: 0.82, latencyMs: 410, quality: 7.4 },
  { id: "claude-3-haiku", label: "Haiku", color: "#14b8a6", costPerRequest: 0.0015, accuracy: 0.78, latencyMs: 350, quality: 7.1 },
  { id: "o1", label: "o1", color: "#dc2626", costPerRequest: 0.05, accuracy: 0.95, latencyMs: 3200, quality: 9.2 },
];

export const SAMPLE_CSV = `prompt,expected
What is 2 + 2?,"4"
Translate 'hello' to French.,bonjour
Summarize: The cat sat on the mat.,A cat sat on a mat.
Is Python statically typed?,Python is dynamically typed.
Write a haiku about clouds.,any coherent haiku
What is the capital of France?,Paris
Explain recursion in one sentence.,A function that calls itself.
Who wrote Romeo and Juliet?,William Shakespeare`;

// Parsed form of the sample dataset, used when no CSV is uploaded.
export const SAMPLE_PROMPTS: { prompt: string; expected: string }[] = [
  { prompt: "What is 2 + 2?", expected: "4" },
  { prompt: "Translate 'hello' to French.", expected: "bonjour" },
  { prompt: "Summarize: The cat sat on the mat.", expected: "A cat sat on a mat." },
  { prompt: "Is Python statically typed?", expected: "Python is dynamically typed." },
  { prompt: "Write a haiku about clouds.", expected: "any coherent haiku" },
  { prompt: "What is the capital of France?", expected: "Paris" },
  { prompt: "Explain recursion in one sentence.", expected: "A function that calls itself." },
  { prompt: "Who wrote Romeo and Juliet?", expected: "William Shakespeare" },
];

// Build result rows for the selected models over `promptCount` prompts.
export function buildResults(
  selectedIds: string[],
  promptCount: number,
): BenchmarkResult[] {
  return BENCHMARK_MODELS.filter((m) => selectedIds.includes(m.id)).map((m) => ({
    id: m.id,
    label: m.label,
    color: m.color,
    costPerRequest: m.costPerRequest,
    totalCost: m.costPerRequest * promptCount,
    accuracy: m.accuracy,
    latencyMs: m.latencyMs,
    quality: m.quality,
  }));
}

// Recommendation: best quality-per-cost among models that are accurate
// (accuracy >= 0.85). Falls back to the most accurate if none clear the bar.
export function recommendId(results: BenchmarkResult[]): string {
  const accurate = results.filter((r) => r.accuracy >= 0.85);
  const pool = accurate.length ? accurate : results;
  return [...pool].sort(
    (a, b) => b.quality / b.costPerRequest - a.quality / a.costPerRequest,
  )[0].id;
}
