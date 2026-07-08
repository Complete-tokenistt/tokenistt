import fs from "fs";
import path from "path";
import type { ShadowAiEvent } from "./types";

// Reads/writes Shadow-AI findings pushed by the Prompt 10 expense scanner
// (POST /api/shadow-ai/scan). Falls back to [] when nothing has been ingested.
const FILE = path.resolve(process.cwd(), "data", "shadow-ai-ingest.json");

export function loadIngestedShadowAi(): ShadowAiEvent[] {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, "utf8")) as ShadowAiEvent[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveIngestedShadowAi(events: ShadowAiEvent[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(events, null, 2));
}
