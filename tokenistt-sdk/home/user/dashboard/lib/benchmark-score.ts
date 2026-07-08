// Scoring helpers for live benchmark evaluation (server-side).
// Deterministic, dependency-free. Production would swap `scoreQuality`
// for an LLM-as-judge.

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 1 if the output matches expected (exact for short answers, containment for long).
export function scoreAccuracy(output: string, expected: string): number {
  const e = normalize(expected);
  if (!e) return 0;
  const o = normalize(output);
  const eWords = e.split(" ");
  if (eWords.length <= 4) return o === e ? 1 : 0;
  return o.includes(e) || eWords.every((w) => o.includes(w)) ? 1 : 0;
}

// Heuristic quality score 0..10 (correctness + length reasonableness).
export function scoreQuality(output: string, expected: string): number {
  const o = normalize(output);
  if (!o) return 0;
  const correct = scoreAccuracy(output, expected);
  const target = Math.max(20, normalize(expected).length * 1.5);
  const lenScore = Math.min(1, o.length / target);
  return Math.max(0, Math.min(10, 5 + correct * 3 + lenScore * 2));
}
