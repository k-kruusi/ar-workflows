/**
 * Convention index — scans the monorepo for CLAUDE.md files and skill references,
 * builds a stat-based content hash, and maintains a disk cache at
 * .cache/conventions-index.json. The index itself never stores file content
 * (that is read live on resolve); it only stores paths and cross-references.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ConventionIndex, ConventionSource, PackageNode } from "./types.js";

/** Extract skill references from a CLAUDE.md body.
 *  Handles both `skills/X.md` and `.claude/skills/X.md` forms. */
export function extractSkillReferences(text: string): string[] {
  const matches = text.matchAll(/(?:\.claude\/)?skills\/[\w-]+\.md/g);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      result.push(m[0]);
    }
  }
  return result;
}

/** Resolve skill reference strings (e.g. `skills/foo.md`) to canonical relative
 *  paths that actually exist in the known path set. Handles the alias where
 *  `skills/X.md` lives at `.claude/skills/X.md` and vice-versa. */
export function resolveSkillPaths(refs: string[], knownPaths: Set<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const basename = ref.replace(/^(?:\.claude\/)?skills\//, "");
    const candidates = [`skills/${basename}`, `.claude/skills/${basename}`];
    for (const c of candidates) {
      if (knownPaths.has(c) && !seen.has(c)) {
        seen.add(c);
        result.push(c);
        break;
      }
    }
  }
  return result;
}

/** Gather all paths whose stats are load-bearing for the content hash: root
 *  CLAUDE.md, all skill files, and all package-level CLAUDE.md files. */
function gatherWatchPaths(repoRoot: string): string[] {
  const paths: string[] = [join(repoRoot, "CLAUDE.md")];

  for (const prefix of ["skills", ".claude/skills"]) {
    const dir = join(repoRoot, ...prefix.split("/"));
    if (existsSync(dir)) {
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(".md")) paths.push(join(dir, f));
        }
      } catch { /* unreadable dir — skip */ }
    }
  }

  for (const parent of ["packages", "dependencies"]) {
    const parentDir = join(repoRoot, parent);
    if (!existsSync(parentDir)) continue;
    try {
      for (const name of readdirSync(parentDir)) {
        paths.push(join(parentDir, name, "CLAUDE.md"));
      }
    } catch { /* unreadable dir — skip */ }
  }

  return paths;
}

/** Stat-based SHA-256 over all watch paths. ~1ms even for large repos since
 *  it only calls stat(), never reads file content. Missing files contribute a
 *  "missing" token so that a file appearing/disappearing also invalidates the hash. */
export function computeContentHash(repoRoot: string, paths: string[]): string {
  const hash = createHash("sha256");
  for (const p of [...paths].sort()) {
    try {
      const s = statSync(p);
      hash.update(`${p}:${s.size}:${s.mtimeMs}\n`);
    } catch {
      hash.update(`${p}:missing\n`);
    }
  }
  // Include repoRoot in the hash so a transplanted cache file from a different
  // machine doesn't match.
  hash.update(`root:${repoRoot}\n`);
  return hash.digest("hex");
}

/** Build a fresh ConventionIndex by scanning the repo. Reads CLAUDE.md files
 *  to extract skill references but does NOT read skill file contents (those are
 *  loaded live on each resolve call). */
export function buildConventionsIndex(repoRoot: string): ConventionIndex {
  // ── Discover skill files ─────────────────────────────────────────────────
  const skillFiles: string[] = [];
  for (const prefix of ["skills", ".claude/skills"]) {
    const dir = join(repoRoot, ...prefix.split("/"));
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".md")) skillFiles.push(`${prefix}/${f}`);
      }
    } catch { /* unreadable — skip */ }
  }
  const knownSkillPaths = new Set(skillFiles);

  // ── Root CLAUDE.md ───────────────────────────────────────────────────────
  const rootClaudeMdPath = "CLAUDE.md";
  let rootSkills: string[] = [];
  const rootClaudeAbsPath = join(repoRoot, rootClaudeMdPath);
  if (existsSync(rootClaudeAbsPath)) {
    try {
      const content = readFileSync(rootClaudeAbsPath, "utf-8");
      rootSkills = resolveSkillPaths(extractSkillReferences(content), knownSkillPaths);
    } catch { /* unreadable — skip */ }
  }

  // ── Per-package CLAUDE.md files ──────────────────────────────────────────
  const packages: PackageNode[] = [];
  for (const parent of ["packages", "dependencies"]) {
    const parentDir = join(repoRoot, parent);
    if (!existsSync(parentDir)) continue;
    let names: string[];
    try {
      names = readdirSync(parentDir);
    } catch {
      continue;
    }
    for (const name of names) {
      let isDir = false;
      try {
        isDir = statSync(join(parentDir, name)).isDirectory();
      } catch { /* skip */ }
      if (!isDir) continue;

      const dir = `${parent}/${name}`;
      const claudeMdAbs = join(repoRoot, dir, "CLAUDE.md");
      let claudeMdPath: string | null = null;
      let referencedSkills: string[] = [];
      if (existsSync(claudeMdAbs)) {
        claudeMdPath = `${dir}/CLAUDE.md`;
        try {
          const content = readFileSync(claudeMdAbs, "utf-8");
          referencedSkills = resolveSkillPaths(extractSkillReferences(content), knownSkillPaths);
        } catch { /* unreadable — skip */ }
      }
      packages.push({ dir, claudeMdPath, referencedSkills });
    }
  }

  // ── Sources list (used for the hash and for discovery logging) ───────────
  const sources: ConventionSource[] = [];
  if (existsSync(rootClaudeAbsPath)) {
    sources.push({ kind: "claude-md", path: rootClaudeMdPath, title: "Root CLAUDE.md" });
  }
  for (const skill of skillFiles) {
    const title = skill.split("/").pop()!.replace(/\.md$/, "");
    sources.push({ kind: "skill", path: skill, title });
  }
  for (const pkg of packages) {
    if (pkg.claudeMdPath) {
      sources.push({ kind: "claude-md", path: pkg.claudeMdPath, title: `${pkg.dir}/CLAUDE.md` });
    }
  }

  const watchPaths = gatherWatchPaths(repoRoot);
  const contentHash = computeContentHash(repoRoot, watchPaths);

  return { contentHash, sources, packages, rootSkills, rootClaudeMdPath };
}

/** Cache-aware loader. Computes the stat-based hash first (~1ms); returns the
 *  on-disk cache if the hash matches, otherwise rebuilds and atomically writes
 *  a fresh cache to .cache/conventions-index.json. */
export function loadOrBuildIndex(repoRoot: string): ConventionIndex {
  const cacheDir = join(repoRoot, ".cache");
  const cachePath = join(cacheDir, "conventions-index.json");
  const watchPaths = gatherWatchPaths(repoRoot);
  const currentHash = computeContentHash(repoRoot, watchPaths);

  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as ConventionIndex;
      if (cached.contentHash === currentHash) {
        return cached;
      }
    } catch { /* corrupt or stale cache — fall through to rebuild */ }
  }

  const fresh = buildConventionsIndex(repoRoot);
  // Atomic write: write to a temp file then rename. On Windows, rename over an
  // existing file fails, so we unlink the destination first.
  const tmpPath = join(cacheDir, `.tmp-conv-${process.pid}.json`);
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(fresh, null, 2), "utf-8");
    try {
      renameSync(tmpPath, cachePath);
    } catch {
      try { unlinkSync(cachePath); } catch { /* ok if missing */ }
      try { renameSync(tmpPath, cachePath); } catch { /* best-effort */ }
    }
  } catch {
    try { unlinkSync(tmpPath); } catch { /* ok */ }
  }

  return fresh;
}
