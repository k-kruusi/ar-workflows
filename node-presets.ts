/**
 * node-presets.ts — named, reviewable node configurations.
 *
 * ## Why this exists
 *
 * `agent:run` takes a deny-by-default capability grant (agent-run-capabilities.ts).
 * That layer is correct and enforced at spawn. What was missing is a place to SEE
 * the grants: every node hand-inlined its own comma-string, 123 of them across 29
 * definitions, so the kit existed only as a distribution nobody had ever printed.
 * The cost of that was concrete — `review-gauntlet-custom` shipped with all six
 * workers declaring nothing (a `work` node that cannot edit, a `ship` node that
 * cannot run git), and it stayed that way because reviewing it required opening
 * every file and diffing by eye.
 *
 * A preset is the fix: one name, one place, enumerable at runtime so the panel can
 * render the whole kit for a human to review in one screen.
 *
 * ## The load-bearing rule: a preset is what EXECUTES, not what is described
 *
 * This tree is full of maps that drifted from their territory — genesis cards nine
 * days stale, scent `did:` entries the code contradicts, `.EVOLVE.md` bullets
 * superseded by commits. A preset kit is another map, and it is only worth having
 * if it CANNOT drift. So `resolveNodeConfig` refuses a node that declares both a
 * preset and an inline capability field, rather than picking a winner. If inline
 * silently overrode the preset, the preset would become a comment — a label
 * asserting something other than what runs, which is precisely the failure mode
 * this file is meant to end.
 *
 * ## Derivation, not invention
 *
 * The five shapes below were read off the tree, not designed: at authoring time
 * they partitioned all 123 `agent:run` nodes with zero remainder. Deliberately NOT
 * recorded here: usage counts. A count baked into source is stale the next time
 * someone edits a definition, and a stale number in a file about honest maps would
 * be self-refuting. Recompute it if you want it.
 */

import type { Capability } from "./nodes/agent-run-capabilities.js";
import { CAPABILITIES } from "./nodes/agent-run-capabilities.js";

/** One named, reviewable node configuration. */
export interface NodePreset {
  /** Stable handle a definition references: `"preset": "scout"`. */
  name: string;
  /** Node type this preset configures. Only `agent:run` is grant-bearing today;
   *  the field is explicit so a future grant-bearing node cannot silently reuse a
   *  preset shaped for a different one. */
  nodeType: string;
  /** The grant, in the same comma-separated grammar `capabilities` already uses —
   *  deliberately the SAME string the parser sees, so a preset cannot express a
   *  grant an inline author could not, and parseCapabilities stays the one
   *  validator. Empty string = deny everything (a pure-text reasoner). */
  capabilities: string;
  /** Route granted verbs through the ar-tools MCP server so the evolution bridge
   *  observes every call. Required for bond-bearing nodes; built-in calls are not
   *  observable. */
  observe?: boolean;
  /** Toolset for the observed path (`ar-tools`, or `ar-tools-local` without web_fetch). */
  tools?: string;
  /** One line, for the panel's list view. */
  summary: string;
  /** WHY this shape is drawn where it is — the whole point of a reviewable kit is
   *  that a human can judge whether the boundary is right, which needs the reason,
   *  not just the verbs. */
  rationale: string;
}

/**
 * The kit. Keys are the names definitions reference.
 *
 * Naming: a bare role is the built-in path; `.observed` suffixes route through
 * ar-tools so calls are audited. The suffix is not cosmetic — it changes which
 * process performs the effect, which is why it is part of the NAME rather than a
 * separate boolean an author could forget to pair correctly.
 */
export const NODE_PRESETS: Record<string, NodePreset> = {
  reasoner: {
    name: "reasoner",
    nodeType: "agent:run",
    capabilities: "",
    summary: "Pure text. No file, shell, or web access at all.",
    rationale:
      "A judge, critic, or synthesizer that reasons over text it was HANDED. Granting " +
      "nothing is the honest default: a reviewer that can edit the thing it reviews can " +
      "quietly fix what it was asked to report, and the report stops being evidence.",
  },
  scout: {
    name: "scout",
    nodeType: "agent:run",
    capabilities: "fs.read",
    summary: "Read and search the tree. Cannot write, run commands, or reach the web.",
    rationale:
      "The most common shape by a wide margin — decompose, design, critique, review. " +
      "Read-only is what makes parallel fan-out safe: N scouts cannot dirty the worktree " +
      "or race each other, so their outputs stay comparable.",
  },
  "scout.observed": {
    name: "scout.observed",
    nodeType: "agent:run",
    capabilities: "fs.read",
    observe: true,
    tools: "ar-tools",
    summary: "Scout, but every call routed through ar-tools so the bridge audits it.",
    rationale:
      "Same grant as scout; the difference is observability, not power. Required wherever " +
      "the run must be auditable after the fact — built-in tool calls leave no trace the " +
      "evolution bridge can see.",
  },
  "scout.observed-local": {
    name: "scout.observed-local",
    nodeType: "agent:run",
    capabilities: "fs.read",
    observe: true,
    tools: "ar-tools-local",
    summary: "Observed scout without web_fetch — for untrusted-content lanes.",
    rationale:
      "Harvest extract/synthesize steps read material already pulled in. Withholding " +
      "web_fetch stops a worker processing untrusted text from following a link that text " +
      "suggests, which is the cheap structural answer to prompt injection.",
  },
  researcher: {
    name: "researcher",
    nodeType: "agent:run",
    capabilities: "fs.read,web",
    summary: "Read the tree and fetch from the web. Cannot write or run commands.",
    rationale:
      "Exploration lanes that must compare what we have against what is out there. Write " +
      "stays denied so a research pass can never leave edits behind — its product is a " +
      "claim, which someone else acts on.",
  },
  verifier: {
    name: "verifier",
    nodeType: "agent:run",
    capabilities: "fs.read,shell",
    summary: "Read and run commands (tests, git, builds). Cannot edit files.",
    rationale:
      "The gate shape: prove something by RUNNING it. Withholding fs.write is the point — " +
      "a verifier that can edit can make a failing check pass by changing the code instead " +
      "of reporting the failure.",
  },
  "verifier.observed": {
    name: "verifier.observed",
    nodeType: "agent:run",
    capabilities: "fs.read,shell",
    observe: true,
    tools: "ar-tools",
    summary: "Verifier with every call audited through ar-tools.",
    rationale:
      "Verifier grant plus observability. Used where the curation decision itself has to be " +
      "reconstructable later, not merely trusted.",
  },
  "verifier.observed-local": {
    name: "verifier.observed-local",
    nodeType: "agent:run",
    capabilities: "fs.read,shell",
    observe: true,
    tools: "ar-tools-local",
    summary: "Observed verifier without web_fetch.",
    rationale:
      "Honesty-gate lanes that run checks over harvested material. Same injection reasoning " +
      "as scout.observed-local: no outbound fetch from a worker handling untrusted text.",
  },
  builder: {
    name: "builder",
    nodeType: "agent:run",
    capabilities: "fs.read,fs.write,shell",
    summary: "Full working grant — read, write, and run commands.",
    rationale:
      "The only shape that may change the tree: implement, revise, ship. Everything else in " +
      "this kit exists so that this grant is requested deliberately and is visible when it is.",
  },
};

/** Preset names, in declaration order — the list an unknown-name error prints. */
export function nodePresetNames(): string[] {
  return Object.keys(NODE_PRESETS);
}

/** The kit as a list, for the panel's review surface. */
export function listNodePresets(): NodePreset[] {
  return Object.values(NODE_PRESETS);
}

/** What a node actually runs with, after the preset (if any) is applied. */
export interface ResolvedNodeConfig {
  /** Raw comma-string handed to parseCapabilities — the one validator. */
  capabilities: string;
  observe: boolean;
  tools: string;
  /** Set when a preset supplied the above; drives the audit line. */
  preset?: string;
}

/** The declared fields of a node, as written in the definition. `undefined` means
 *  the author did not write the field at all — distinct from writing an empty
 *  value, which is a real (deny-everything) grant. */
export interface DeclaredNodeConfig {
  preset?: string;
  capabilities?: string;
  observe?: boolean;
  tools?: string;
}

/**
 * Resolve a node's declared config into what will execute.
 *
 * BOUNDARY function: `declared` comes from workflow-definition JSON, so it is
 * validated defensively rather than asserted (same posture parseCapabilities takes
 * on the same data).
 *
 * Refuses, loudly:
 *  - an unknown preset name (never falls back to deny-everything — that would turn
 *    a typo into a silently toolless worker, which is the exact failure that made
 *    review-gauntlet-custom useless for weeks);
 *  - a preset paired with ANY inline grant field. Not "inline wins" or "preset
 *    wins": both are drift. A definition that says `preset: "scout"` must run the
 *    scout grant or fail — never run something else while claiming to be a scout.
 */
export function resolveNodeConfig(declared: DeclaredNodeConfig): ResolvedNodeConfig {
  const { preset } = declared;

  if (preset === undefined) {
    return {
      capabilities: declared.capabilities ?? "",
      observe: declared.observe ?? false,
      tools: declared.tools ?? "",
    };
  }

  const hit = NODE_PRESETS[preset];
  if (!hit) {
    throw new Error(
      `agent:run: unknown preset "${preset}" (known: ${nodePresetNames().join(", ")}). ` +
        `Presets are defined in src/workflows/node-presets.ts. Omit the field to declare ` +
        `capabilities inline instead.`,
    );
  }

  const conflicts = (["capabilities", "observe", "tools"] as const).filter(
    (k) => declared[k] !== undefined,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `agent:run: node declares preset "${preset}" AND inline ${conflicts.join(", ")}. ` +
        `A preset is what runs, not a label for it — allowing an override would let the ` +
        `definition claim one envelope and execute another. Use the preset alone (it grants ` +
        `"${hit.capabilities || "nothing"}"), or drop the preset and declare inline.`,
    );
  }

  return {
    capabilities: hit.capabilities,
    observe: hit.observe ?? false,
    tools: hit.tools ?? "",
    preset,
  };
}

/** Every verb named by every preset is a real verb. Called by the drift guard test
 *  so a typo in the kit fails the build rather than throwing at spawn time, deep
 *  inside a workflow someone is waiting on. */
export function invalidPresetVerbs(): string[] {
  const known = new Set<string>(CAPABILITIES as readonly string[]);
  const bad: string[] = [];
  for (const p of listNodePresets()) {
    for (const verb of p.capabilities.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!known.has(verb)) bad.push(`${p.name}: ${verb}`);
    }
  }
  return bad;
}

/** Preset whose grant exactly matches this inline config, if one exists — the
 *  migration helper. Lets a definition author (or an audit) find the named shape a
 *  hand-inlined node already is, instead of guessing. */
export function matchPreset(config: {
  capabilities?: string;
  observe?: boolean;
  tools?: string;
}): NodePreset | undefined {
  const norm = (raw: string | undefined): string =>
    (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort().join(",");
  const target = norm(config.capabilities);
  const targetObserve = config.observe ?? false;
  const targetTools = config.tools ?? "";
  return listNodePresets().find(
    (p) =>
      norm(p.capabilities) === target &&
      (p.observe ?? false) === targetObserve &&
      (p.tools ?? "") === targetTools,
  );
}

// ── Review surface ───────────────────────────────────────────────────────────

/** Minimal structural shape of a loaded workflow graph. Declared here rather than
 *  imported so this module stays free of the engine's types (and testable with
 *  literals). */
export interface GraphLike {
  id: string;
  nodes: Array<{ id: string; type: string; params?: Record<string, unknown> }>;
}

/** A grant-bearing node that does NOT reference the kit. */
export interface InlinedNode {
  /** `blueprintId:nodeId` — where to go fix it. */
  at: string;
  capabilities: string;
  observe: boolean;
  tools: string;
  /** The preset this node already IS, when the kit covers its shape. Absent means
   *  the kit has no name for it — which is a question about the kit, not a defect
   *  in the node. */
  suggested?: string;
}

/** What the panel renders: the kit, plus how the loaded blueprints actually use it. */
export interface PresetAdoption {
  presets: NodePreset[];
  /** preset name → `blueprintId:nodeId` list. Every preset appears, including
   *  unused ones — a preset nobody uses is a review finding, not something to hide. */
  usage: Record<string, string[]>;
  /** Grant-bearing nodes still hand-inlining their envelope. */
  inlined: InlinedNode[];
  /** Nodes declaring NOTHING — deny-everything pure-text reasoners. Legitimate for a
   *  judge, and a silent bug for a worker that needs to read (this is exactly how
   *  review-gauntlet-custom shipped six toolless workers), so they are surfaced for
   *  a human to judge rather than auto-classified either way. */
  undeclared: string[];
}

/**
 * Summarize how a set of loaded graphs uses the kit.
 *
 * Pure: takes graphs, returns a report, touches no disk. The caller supplies
 * whatever it has in memory, so the panel never triggers a definition re-scan.
 *
 * Deliberately reports rather than judges. It does not call an inlined node wrong
 * (some shapes legitimately have no preset) or an undeclared node wrong (a judge
 * SHOULD have nothing). Naming what is true and letting a human decide is the
 * entire reason this surface exists.
 */
export function summarizePresetAdoption(graphs: readonly GraphLike[]): PresetAdoption {
  const usage: Record<string, string[]> = {};
  for (const name of nodePresetNames()) usage[name] = [];
  const inlined: InlinedNode[] = [];
  const undeclared: string[] = [];

  for (const g of graphs) {
    for (const node of g.nodes) {
      if (node.type !== "agent:run") continue;
      const p = node.params ?? {};
      const at = `${g.id}:${node.id}`;

      const preset = typeof p.preset === "string" ? p.preset : undefined;
      if (preset !== undefined) {
        // An unknown name is recorded, not thrown: this is a report over possibly
        // broken definitions, and a reviewer needs to SEE the typo. The throw that
        // matters already happens at run time, in resolveNodeConfig.
        (usage[preset] ??= []).push(at);
        continue;
      }

      const capabilities = typeof p.capabilities === "string" ? p.capabilities : undefined;
      const observe = typeof p.observe === "boolean" ? p.observe : false;
      const tools = typeof p.tools === "string" ? p.tools : "";
      if (capabilities === undefined) {
        undeclared.push(at);
        continue;
      }
      inlined.push({
        at,
        capabilities,
        observe,
        tools,
        suggested: matchPreset({ capabilities, observe, tools })?.name,
      });
    }
  }

  return { presets: listNodePresets(), usage, inlined, undeclared };
}

/** Type-only re-export so callers building presets can name the verb type without
 *  reaching into the nodes/ directory. */
export type { Capability };
