/**
 * Convention resolution — maps a worker cwd to the set of CLAUDE.md + skill
 * files that apply to it, reads their content live (never cached), and formats
 * the preamble that agent:run prepends to the prompt.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ConventionBundle, ConventionIndex, ConventionMatch } from "./types.js";
import { loadOrBuildIndex } from "./index.js";

export interface ConventionIndexRef {
  current: ConventionIndex;
  repoRoot: string;
  rebuild(): ConventionIndex;
}

/** Find the repo-relative package dir (e.g. `packages/foo`) whose tree contains
 *  the given absolute cwd. Two strategies:
 *
 *  1. Suffix-match: does the normalized absoluteCwd contain `.../packages/<name>`
 *     or `.../dependencies/<name>`?
 *  2. Fallback: read `cwd/package.json` `.name` field and match its basename
 *     against known dir basenames.
 *
 *  Returns null if no match is found. */
export function resolvePackagePath(cwd: string, knownDirs: string[]): string | null {
  const normalizedCwd = cwd.replace(/\\/g, "/");

  for (const dir of knownDirs) {
    const normalizedDir = dir.replace(/\\/g, "/");
    if (
      normalizedCwd.includes(`/${normalizedDir}/`) ||
      normalizedCwd.endsWith(`/${normalizedDir}`)
    ) {
      return dir;
    }
  }

  // Fallback: try reading package.json
  try {
    const pkgJson = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf-8"),
    ) as { name?: string };
    if (pkgJson.name) {
      const pkgBasename = pkgJson.name.split("/").pop() ?? pkgJson.name;
      const match = knownDirs.find((d) => basename(d) === pkgBasename);
      if (match) return match;
    }
  } catch { /* no package.json or unreadable — skip */ }

  return null;
}

/** Resolve the full convention bundle for a given cwd. Re-checks the stat-based
 *  content hash on every call (~1ms); rebuilds the index if the repo has changed
 *  since the last call. File content is always read LIVE — never from the index. */
export async function resolveConventions(
  indexRef: ConventionIndexRef,
  cwd: string,
): Promise<ConventionBundle> {
  // Refresh index if stale (loadOrBuildIndex is hash-aware; returns cached fast
  // when nothing has changed, rebuilds on mismatch).
  indexRef.current = indexRef.rebuild();
  const index = indexRef.current;
  const { repoRoot } = indexRef;

  const knownDirs = index.packages.map((p) => p.dir);
  const resolvedPackageDir = resolvePackagePath(cwd, knownDirs);

  const matched: ConventionMatch[] = [];
  const seenPaths = new Set<string>();

  const addMatch = (relPath: string, reason: ConventionMatch["reason"]): void => {
    if (seenPaths.has(relPath)) return;
    const absPath = join(repoRoot, ...relPath.split("/"));
    if (!existsSync(absPath)) return; // Deleted since index built — skip honestly
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      return;
    }
    seenPaths.add(relPath);
    const title = reason === "root-convention"
      ? "Root CLAUDE.md"
      : relPath.split("/").pop()!.replace(/\.md$/, "");
    matched.push({ path: relPath, title, content, reason });
  };

  // ── Resolution order: root → root skills → package → package skills ──────
  addMatch(index.rootClaudeMdPath, "root-convention");
  for (const skillPath of index.rootSkills) {
    addMatch(skillPath, "root-referenced-skill");
  }
  if (resolvedPackageDir !== null) {
    const pkg = index.packages.find((p) => p.dir === resolvedPackageDir);
    if (pkg) {
      if (pkg.claudeMdPath) {
        addMatch(pkg.claudeMdPath, "package-claude-md");
      }
      for (const skillPath of pkg.referencedSkills) {
        addMatch(skillPath, "package-referenced-skill");
      }
    }
  }

  // Empty when the only match is root CLAUDE.md (body skipped in preamble) or
  // there are no matches at all — nothing useful to inject.
  const empty = !matched.some((m) => m.reason !== "root-convention");
  return { cwd, resolvedPackageDir, matched, empty };
}

/** Format a ConventionBundle into a preamble string for prepending to an agent
 *  prompt. NEVER returns an empty string (Honest Response Principle).
 *
 *  - Root CLAUDE.md body is SKIPPED (auto-loaded by `claude -p` when the worker
 *    runs from the monorepo root; its value is in the skills it references).
 *  - Skill files and package CLAUDE.md are included verbatim.
 *  - Deduplicates by path so a skill referenced by both root and package only
 *    appears once. */
export function formatConventionsPreamble(bundle: ConventionBundle): string {
  if (bundle.empty) {
    if (bundle.resolvedPackageDir === null) {
      return (
        "## House Conventions\n\n" +
        "No conventions to inject: the worker's cwd could not be resolved to a " +
        "known package in this repository. Run from a path under packages/ or " +
        "dependencies/ so package-specific conventions are picked up."
      );
    }
    return (
      `## House Conventions\n\n` +
      `No package-specific conventions found for \`${bundle.resolvedPackageDir}\`. ` +
      `The root CLAUDE.md is auto-loaded when the worker runs from the monorepo root.`
    );
  }

  const sections: string[] = ["## House Conventions"];
  const seenPaths = new Set<string>();

  for (const match of bundle.matched) {
    // Skip root CLAUDE.md body — auto-loaded by the CLI; its prose adds noise to
    // an ephemeral worker whose value is in the referenced skills, not the prose.
    if (match.reason === "root-convention") continue;
    if (seenPaths.has(match.path)) continue;
    seenPaths.add(match.path);
    sections.push(`### ${match.title}\n\n${match.content.trim()}`);
  }

  return sections.join("\n\n");
}

/** Append explicit skill paths to an already-resolved bundle.
 *
 *  Skill paths are repo-root-relative (e.g. `"skills/scent.md"`,
 *  `".claude/skills/gpu-lease.md"`). Forward-slashes only; backslashes are
 *  normalised automatically. Paths already in the auto bundle are silently
 *  skipped (seenPaths dedup). Missing or unreadable files are skipped honestly
 *  (same policy as addMatch). Returns the original bundle unchanged when no
 *  new paths are added. */
export function mergeExplicitSkills(
  bundle: ConventionBundle,
  skillPaths: string[],
  repoRoot: string,
): ConventionBundle {
  if (skillPaths.length === 0) return bundle;

  const seenPaths = new Set(bundle.matched.map((m) => m.path));
  const added: ConventionMatch[] = [];

  for (const raw of skillPaths) {
    const relPath = raw.trim().replace(/\\/g, "/");
    if (!relPath) continue;
    if (seenPaths.has(relPath)) continue;

    const absPath = join(repoRoot, ...relPath.split("/"));
    if (!existsSync(absPath)) continue;

    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    seenPaths.add(relPath);
    added.push({
      path: relPath,
      title: relPath.split("/").pop()!.replace(/\.md$/, ""),
      content,
      reason: "explicit-skill",
    });
  }

  if (added.length === 0) return bundle;

  const matched = [...bundle.matched, ...added];
  // Recalculate empty: bundle is non-empty if any match isn't just root-convention.
  const empty = !matched.some((m) => m.reason !== "root-convention");
  return { ...bundle, matched, empty };
}

// Re-export for caps.ts to call directly without importing from index.ts.
export { loadOrBuildIndex };
