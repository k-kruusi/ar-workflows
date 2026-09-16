/**
 * agent-run-capabilities.ts — the capability grammar for agent:run's worker envelope.
 *
 * DENY-BY-DEFAULT. A node that declares no `capabilities` gets an envelope with
 * NO effect verbs at all: every file/shell/web built-in is subtracted-from-nothing
 * and therefore stays in the `--disallowedTools` list, and no ar-tools MCP child
 * is attached. A worker cannot exceed its envelope because the envelope is the
 * ABSENCE of tools — enforced by the claude/grok CLI and the ar-tools registrar,
 * not by a rule the worker could rewrite.
 *
 * Two coordinated enforcement layers derive from ONE capability set:
 *   1. argv layer  — `disallowedTools = FULL_BLOCK − granted built-ins`. Always set.
 *   2. MCP layer   — when ar-tools is attached, `TOOLS = mcpKeys(granted)`. Omitting
 *                    the `bash` key means `run_command` is never registered.
 * Blocking built-in `Bash` while attaching ar-tools' unrestricted `run_command`
 * would be theater; layer 2 is what makes layer 1 honest.
 *
 * Everything here is PURE (no I/O, no imports beyond the sibling blocklists), so
 * the whole grammar unit-tests without spawning anything.
 */

import { CLAUDE_ALWAYS_BLOCK, CLAUDE_BUILTIN_BLOCK } from "./agent-run-tools.js";

/** The grantable capability verbs. Deny-by-default: absent ⇒ none. */
export type Capability = "fs.read" | "fs.write" | "shell" | "web";

/** Every valid verb, in declaration order — the list an unknown-verb error prints. */
export const CAPABILITIES: readonly Capability[] = ["fs.read", "fs.write", "shell", "web"] as const;

/**
 * verb → claude built-in tool names (argv-subtraction, the observe:false path).
 *
 * INVARIANT (drift-guarded in agent-run-capabilities.test.ts): the union of these
 * lists is EXACTLY CLAUDE_BUILTIN_BLOCK. If a new built-in joins that block
 * without being mapped to a verb here, the guard fails the build — otherwise the
 * new tool would be permanently unblockable-by-grant (dead) or, worse, silently
 * ungoverned. Interactive tools (CLAUDE_ALWAYS_BLOCK) are deliberately absent:
 * they are never grantable, so they are never subtracted.
 */
export const CAP_BUILTINS: Record<Capability, string[]> = {
  "fs.read": ["Read", "Glob", "Grep"],
  "fs.write": ["Write", "Edit", "NotebookEdit"],
  shell: ["Bash"],
  web: ["WebFetch", "WebSearch"],
};

/**
 * Shell-equivalent CLI built-ins that are ABSENT from CLAUDE_BUILTIN_BLOCK.
 *
 * WHY THIS EXISTS — Step-0 live finding, 2026-07-25. A real `claude -p` worker
 * spawned with the full 18-name deny list (CLAUDE_ALWAYS_BLOCK ∪ CLAUDE_BUILTIN_BLOCK)
 * and TOOLS=read,grep,glob reported `TOOL_USED: PowerShell / OUTPUT: STEP0MARKER` —
 * it executed an arbitrary shell command. `Bash` was blocked; `PowerShell` is a
 * SEPARATE built-in the grok-mirrored list never covered. Re-running the probe
 * with PowerShell added yielded `TOOL_USED: NONE / BLOCKED`. So the design's §8.1
 * claim ("both shell doors shut at the default") is only true with these names.
 *
 * Kept SEPARATE from CLAUDE_BUILTIN_BLOCK on purpose: that constant is drift-guarded
 * byte-for-byte against the canonical grok-disallowed-tools.mjs (a grok CLI has no
 * PowerShell tool), and widening it would either break that guard or silently
 * redefine grok's contract. These names ride the `shell` verb — a shell-granted
 * worker gets them back, a default worker never sees them.
 */
export const CAP_EXTRA_BUILTINS: Record<Capability, string[]> = {
  "fs.read": [],
  "fs.write": [],
  shell: ["PowerShell", "KillShell", "BashOutput"],
  web: [],
};

/**
 * Delegation verbs — NEVER grantable, always blocked.
 *
 * A subagent spawned by the worker is a child whose envelope this gate does not
 * compute, so `Task`/`Agent` is capability escape by delegation: a no-shell worker
 * could ask a subagent to run the shell for it. This is the claude-side parity of
 * grok's `--no-subagents` (grok-disallowed-tools.mjs:79), which the grok path
 * already passes unconditionally in MCP-only mode. Both names are listed because
 * the CLI has used both across versions; an unknown name in --disallowedTools is
 * an inert no-op, so listing both is safe and version-proof.
 */
export const CLAUDE_DELEGATION_BLOCK = ["Task", "Agent"];

/**
 * verb → ar-tools registry keys (the TOOLS env subset, observe:true path).
 * Keys are the canonical registry keys from packages/tools/src/server.ts:19-36
 * (ALL_TOOLS) — an unlisted key is simply not registered by createMcpServer.
 */
export const CAP_MCP_KEYS: Record<Capability, string[]> = {
  "fs.read": ["read", "glob", "grep", "read-symbol", "file-outline"],
  "fs.write": ["write", "edit", "edit-range", "edit-symbol"],
  shell: ["bash"], // ← the run_command key; omit ⇒ no shell over MCP
  web: ["web-fetch"],
};

/**
 * The TOOLS value meaning "register NOTHING".
 *
 * MUST NOT be the empty string. server.ts:41-43 reads
 * `process.env.TOOLS ? split(TOOLS) : Object.keys(ALL_TOOLS)` — `""` is FALSY, so
 * an empty TOOLS is read as UNSET and registers the ENTIRE 16-tool surface,
 * `run_command` included. That is a fail-OPEN inversion of the intent, and the
 * base-node design's §3.1 literally specified `""` for this case. Live-probed
 * 2026-07-25: `TOOLS=""` → 19 tools incl. run_command; `TOOLS="none"` →
 * `[tools] Unknown tool: none` / `Registered tools: ` / 0 tools. An unrecognized
 * key is warned-and-skipped (server.ts:51-57), so a sentinel that matches no
 * registry key is the only value that fails CLOSED.
 */
export const MCP_TOOLS_NONE = "none";

export interface CapabilitySet {
  /** Parsed verbs; [] when the field was absent or empty (DENY-BY-DEFAULT). */
  caps: readonly Capability[];
  /** Route effects through ar-tools MCP (audited by the evolution bridge) vs built-ins. */
  observe: boolean;
  /** Was the field present at all? Drives the migration warning, not the envelope. */
  declared: boolean;
}

function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v);
}

/**
 * Parse the comma-separated `capabilities` string into a CapabilitySet.
 *
 * BOUNDARY: `raw` comes from a workflow definition's JSON — author-controlled but
 * not code-reviewed on the external/user path — so it is validated defensively
 * here. An unknown verb THROWS listing the valid verbs (Honest Response): silently
 * dropping it would hand the author an envelope narrower than the one they wrote
 * and read as a mysterious tool outage downstream.
 *
 * Absent/empty ⇒ `{ caps: [], declared: false }` — a valid, maximally-restricted
 * envelope (a pure-text reasoner), NOT an error. Rung 2 never hard-denies on an
 * empty set; hard-deny is reserved for conflict.
 */
export function parseCapabilities(raw: string, observe: boolean): CapabilitySet {
  const trimmed = raw.trim();
  if (trimmed === "") return { caps: [], observe, declared: false };

  const seen = new Set<Capability>();
  for (const part of trimmed.split(",")) {
    const verb = part.trim();
    if (verb === "") continue; // tolerate "fs.read,," — an empty slot names nothing
    if (!isCapability(verb)) {
      throw new Error(
        `agent:run: unknown capability "${verb}" in capabilities "${raw}" ` +
          `(valid verbs: ${CAPABILITIES.join(", ")})`,
      );
    }
    seen.add(verb);
  }
  return { caps: [...seen], observe, declared: true };
}

/**
 * argv layer: FULL_BLOCK − granted built-ins.
 *
 * FULL_BLOCK = interactive ∪ built-ins ∪ extra-shell ∪ delegation. Only the
 * built-in and extra-shell names are ever subtracted, so the result ALWAYS
 * contains every interactive and delegation name — those are not grantable by
 * any capability string. Order is stable (block order, filtered) so the joined
 * argv value is deterministic and diffable in an audit record.
 *
 * `observe:true` subtracts NOTHING. The whole promise of that mode is that every
 * granted effect flows through ar-tools MCP where the evolution bridge records it;
 * leaving the equivalent BUILT-IN available would let the worker do the same work
 * unobserved, which makes the capability-escape proof read a log with holes in it —
 * a silent downgrade from "audited" to "audited unless it chose otherwise". So on
 * the observed path the argv layer blocks everything and CAP_MCP_KEYS is the sole
 * grant channel. Live-verified 2026-07-25: an observe:true fs.read worker that also
 * kept built-in Read/Glob/Grep was the pre-fix behaviour; it now lists only
 * mcp__ar-tools__* effect tools.
 */
export function computeDisallowedTools(set: CapabilitySet): string[] {
  const granted = new Set<string>();
  if (!set.observe) {
    for (const cap of set.caps) {
      for (const name of CAP_BUILTINS[cap]) granted.add(name);
      for (const name of CAP_EXTRA_BUILTINS[cap]) granted.add(name);
    }
  }

  const full = [
    ...CLAUDE_ALWAYS_BLOCK,
    ...CLAUDE_BUILTIN_BLOCK,
    ...Object.values(CAP_EXTRA_BUILTINS).flat(),
    ...CLAUDE_DELEGATION_BLOCK,
  ];
  return [...new Set(full)].filter((name) => !granted.has(name));
}

/**
 * MCP layer: the `TOOLS` env value for the ar-tools stdio child.
 *
 * A pure function of `set.caps` — deliberately INDEPENDENT of `observe`. Whenever
 * an ar-tools child exists it must be gated by the capability set, because the
 * child's surface is an effect surface: leaving `TOOLS` unset hands the worker
 * `run_command`, an unrestricted shell, no matter what the argv layer blocked.
 *
 * This previously keyed on `observe`, which reopened the exact hole rung 2 exists
 * to close: `tools:"ar-tools"` with the default `observe:false` returned undefined,
 * so no `TOOLS` was written, so the child registered all 16 tools — a node granted
 * only `fs.read` got a shell, while argv dutifully blocked built-in `Bash`. That is
 * A-B1 ("blocking `Bash` while attaching `run_command` is theater") verbatim.
 * `observe` governs only whether the BUILT-INS are also available
 * (see computeDisallowedTools); it never governs what MCP registers.
 *
 * Never returns `""`. No capabilities ⇒ MCP_TOOLS_NONE — see that constant for why
 * the empty string fails open.
 *
 * Registry keys with no verb (`vitals`, `typecheck`, `data-shape`, `data-select`,
 * `ccr`) are unreachable by design: deny-by-default means an unmapped key is
 * simply never granted. That is the safe direction, so it is deliberately NOT
 * drift-guarded — MCP keys are opt-in, unlike built-ins which must all be
 * accounted for (see CAP_BUILTINS).
 */
export function computeMcpToolsSubset(set: CapabilitySet): string {
  const keys: string[] = [];
  for (const cap of set.caps) {
    for (const key of CAP_MCP_KEYS[cap]) if (!keys.includes(key)) keys.push(key);
  }
  return keys.length > 0 ? keys.join(",") : MCP_TOOLS_NONE;
}
