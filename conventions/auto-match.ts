/**
 * auto-match.ts — dependency-light task→skill matching.
 *
 * Loads `.skill-index/index.json` as plain JSON (no @helmetfire-labs/skill-index
 * import — avoids adding that dep to the root package). Tries Ollama embedding
 * with a 2s timeout; falls back to lexical matching over triggerText + whenToUse.
 * Returns the top-3 matched skill paths and which mode fired.
 *
 * Used by agent:run when `skills:"auto-match"` is passed — the caller merges the
 * returned paths through mergeExplicitSkills exactly like hand-listed paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MatchMode = "embedding" | "lexical" | "none";

export interface AutoMatchResult {
  paths: string[];
  mode: MatchMode;
}

interface SlimRecord {
  id: string;
  path: string;
  triggerText?: string;
  whenToUse?: string;
  description?: string;
  disableModelInvocation?: boolean;
}

interface SlimVector {
  skillId: string;
  role: string;
  vector: number[];
}

interface SlimIndex {
  skills?: SlimRecord[];
  vectors?: SlimVector[];
  dimensions?: number;
  queryPrefix?: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function ollamaEmbed(text: string, prefix: string, ollamaUrl: string): Promise<number[] | null> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", input: prefix + text }),
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) return null;
    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  } catch {
    return null;
  }
}

const TOP_K = 3;
const EMBEDDING_MIN = 0.3;
const LEXICAL_MIN = 0.15;

function lexicalScore(task: string, rec: SlimRecord): number {
  const target = [rec.triggerText ?? "", rec.whenToUse ?? "", rec.description ?? ""]
    .join(" ")
    .toLowerCase();
  const words = task.toLowerCase().split(/\W+/).filter(Boolean);
  if (words.length === 0) return 0;
  const hits = words.filter((w) => target.includes(w)).length;
  return hits / words.length;
}

export async function autoMatch(
  taskText: string,
  repoRoot: string,
  ollamaUrl = "http://127.0.0.1:11434",
): Promise<AutoMatchResult> {
  const indexPath = join(repoRoot, ".skill-index", "index.json");
  if (!existsSync(indexPath)) return { paths: [], mode: "none" };

  let idx: SlimIndex;
  try {
    idx = JSON.parse(readFileSync(indexPath, "utf-8")) as SlimIndex;
  } catch {
    return { paths: [], mode: "none" };
  }

  const skills = (idx.skills ?? []).filter((s) => !s.disableModelInvocation);
  if (skills.length === 0) return { paths: [], mode: "none" };

  // Try embedding first (2s timeout — if Ollama is absent or slow, falls through)
  if (idx.vectors && idx.dimensions && idx.queryPrefix !== undefined) {
    const qVec = await ollamaEmbed(taskText, idx.queryPrefix, ollamaUrl);
    if (qVec && qVec.length === idx.dimensions) {
      const triggerVecs = new Map<string, number[]>();
      for (const v of idx.vectors) {
        if (v.role === "trigger") triggerVecs.set(v.skillId, v.vector);
      }
      const scored = skills
        .filter((s) => triggerVecs.has(s.id))
        .map((s) => ({ path: s.path, score: cosine(qVec, triggerVecs.get(s.id)!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K)
        .filter((x) => x.score > EMBEDDING_MIN);
      if (scored.length > 0) {
        return { paths: scored.map((x) => x.path), mode: "embedding" };
      }
    }
  }

  // Lexical fallback — word overlap over triggerText + whenToUse + description
  const scored = skills
    .map((s) => ({ path: s.path, score: lexicalScore(taskText, s) }))
    .filter((x) => x.score >= LEXICAL_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  return {
    paths: scored.map((x) => x.path),
    mode: scored.length > 0 ? "lexical" : "none",
  };
}
