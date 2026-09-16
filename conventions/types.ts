/**
 * Convention injection types — the data model for how agent:run nodes receive
 * house conventions (CLAUDE.md files + referenced skill docs) scoped to their cwd.
 */

export interface ConventionSource {
  kind: "claude-md" | "skill";
  path: string;
  title: string;
}

export interface PackageNode {
  dir: string;
  claudeMdPath: string | null;
  referencedSkills: string[];
}

export interface ConventionIndex {
  contentHash: string;
  sources: ConventionSource[];
  packages: PackageNode[];
  rootSkills: string[];
  rootClaudeMdPath: string;
}

export interface ConventionMatch {
  path: string;
  title: string;
  content: string;
  reason: "root-convention" | "package-claude-md" | "package-referenced-skill" | "root-referenced-skill" | "explicit-skill";
}

export interface ConventionBundle {
  cwd: string;
  resolvedPackageDir: string | null;
  matched: ConventionMatch[];
  empty: boolean;
}
