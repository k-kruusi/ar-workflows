/**
 * agent-run-tools.ts — pure builders for agent:run's `tools: "ar-tools"` mode.
 *
 * When a workflow opts an ephemeral agent into `tools: "ar-tools"`, the spawned
 * `claude -p` / `grok` worker gets the SAME AgentRuntime MCP toolset the live
 * fleet uses (ar-tools' file/shell/grep/vitals + the evolution bridge that
 * records tool-mutation data), and its conflicting built-ins are disallowed so
 * every call flows through MCP — exactly the discipline claude-worker-loader.mjs
 * / grok-worker-loader.mjs apply to fleet agents.
 *
 * Everything here is PURE (no filesystem, no spawn — `node:path` only), so the
 * argv/config shapes unit-test without launching a worker. The one owner of I/O
 * is agent-run.ts, which writes the config files these builders produce and
 * threads the flags into its spawn. Path resolution mirrors container-manager.ts
 * (STDIO_TOOL_SERVERS / EVOLUTION_BRIDGE_PATH / the evolve argv recipe); the
 * blocklists are duplicated from claude-worker-loader.mjs with file:line
 * citations and drift-guarded in the unit test against the canonical
 * grok-disallowed-tools.mjs constants.
 */

import { join } from "node:path";

/** Env allowlist for agent:run's `workerProfile` mode — ONLY these keys are
 *  pulled from the profile cartridge's workspace.json env block into the
 *  ephemeral worker's spawn env. Container IDENTITY (git author, REPO_MEMORY_*)
 *  and the cartridge's TOOL surface (disableBuiltinTools, ENABLE_TOOL_SEARCH)
 *  stay out on purpose: a worker's tools are the LEG's decision (agent:run's
 *  `capabilities`), not the borrowed cartridge's. ANTHROPIC_AUTH_TOKEN rides
 *  this merge scoped to THIS spawn only — the .EVOLVE.md 2026-07-19 lesson (a
 *  global token poisons the whole native fleet); the value is never logged and
 *  never placed in argv (env-only). Pure constant; the fs read that uses it
 *  lives in agent-run.ts (the I/O owner).
 *
 *  CONTEXT WINDOW CROSSES, and it is not "tuning" — it is MODEL-COUPLED.
 *  This list once excluded it as container-specific, which made a borrowed seat
 *  silently WEAKER than the seat it names: kimi-1 pins `k3[1m]` — literally the
 *  1M-context variant — alongside CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576. A
 *  worker that borrowed the 1M weights but not the 1M window would auto-compact
 *  at the CLI default, mid-build, with nothing in any receipt to say why its
 *  output got worse. Borrowing a route means borrowing the envelope that route
 *  was configured for; a leg that wants a smaller window should say so on the
 *  leg. Verified against a live spawn: receipt modelConfigured "k3[1m]",
 *  routeHost localhost:3075 (run wf-1786329170193-vqf4dd). */
export const WORKER_PROFILE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
] as const;

/** Absolute paths the ar-tools MCP server is wired from — resolved off the
 *  monorepo root, mirroring container-manager.ts:84-87,1538-1543. */
export interface ArToolsPaths {
  /** <root>/src/mcp-evolution-bridge.ts — wraps the stdio server so every tool
   *  call is observed for mutation data (container-manager.ts:87). */
  evolutionBridgePath: string;
  /** <root>/packages/tools/src/stdio.ts — the ar-tools stdio MCP entrypoint
   *  (STDIO_TOOL_SERVERS["ar-tools"], container-manager.ts:85). */
  stdioServerPath: string;
  /** <root>/ar-tools/data/evolution — the fleet's genome dir for ar-tools
   *  (resolve(projectsDir, "ar-tools", "data", "evolution"), container-manager.ts:1540;
   *  projectsDir defaults to cwd = monorepo root, container-manager.ts:157). */
  genomeDir: string;
}

/** The `--mcp-config` payload for a claude worker: one stdio "ar-tools" server
 *  spawned via the evolution bridge. */
export interface ArToolsMcpConfig {
  mcpServers: {
    "ar-tools": {
      command: string;
      args: string[];
      /** Extra env for the stdio child — set by buildArToolsLocalMcpConfig
       *  (e.g. AR_TOOLS_DISABLE_WEB_FETCH=1). Optional: the non-local variant omits it. */
      env?: Record<string, string>;
    };
  };
}

/**
 * Resolve the three ar-tools paths off `monorepoRoot` (the inner agentruntime/
 * dir that holds agentruntime.json, src/, packages/). Byte-mirrors the
 * container-manager derivation so agent:run wires the SAME server the supervisor
 * does. Pure — no existence check here (agent-run.ts validates before spawning,
 * so it can throw a named-path Honest-Response error).
 */
export function resolveArToolsPaths(monorepoRoot: string): ArToolsPaths {
  return {
    // container-manager.ts:87 — resolve(__dirname, "mcp-evolution-bridge.ts"), __dirname = <root>/src
    evolutionBridgePath: join(monorepoRoot, "src", "mcp-evolution-bridge.ts"),
    // container-manager.ts:85,1538 — STDIO_TOOL_SERVERS["ar-tools"] = "packages/tools/src/stdio.ts"
    stdioServerPath: join(monorepoRoot, "packages", "tools", "src", "stdio.ts"),
    // container-manager.ts:1540 — resolve(projectsDir, "ar-tools", "data", "evolution")
    genomeDir: join(monorepoRoot, "ar-tools", "data", "evolution"),
  };
}

/** Per-tool + web gating for the ar-tools stdio child, threaded through the child `env`. */
export interface ArToolsMcpConfigOpts {
  /**
   * `TOOLS` — comma-separated ar-tools registry keys. Omitted keys are NOT
   * registered, in both stdio and SSE (packages/tools/src/server.ts:41-58). This is
   * the per-tool MCP gate: without the `bash` key the child never registers
   * `run_command`, so blocking built-in `Bash` stops being theatre.
   *
   * MUST NOT be `""` — server.ts:41 reads `process.env.TOOLS ? … : ALL_TOOLS`, so an
   * empty value is falsy and registers EVERYTHING (fail-open). Pass the
   * MCP_TOOLS_NONE sentinel from agent-run-capabilities.ts for "register nothing";
   * an empty string is rejected below rather than silently inverted.
   */
  toolsSubset?: string;
  /** `AR_TOOLS_DISABLE_WEB_FETCH=1` — drop web_fetch so a worker cannot self-fetch. */
  disableWebFetch?: boolean;
}

/**
 * Build the claude `--mcp-config` object. The argv is byte-identical to the evolve
 * branch in container-manager.ts:1541-1544: `npx tsx <bridge> --cmd npx --args
 * tsx,<stdio> --dir <genomeDir>`. The bridge wraps the stdio server; `--dir` points
 * it at the genome so tool-mutation tips accumulate in the fleet's shared store.
 *
 * `opts` adds ONLY child-env entries — the command and args never vary — so the
 * envelope's per-tool gate rides the same seam AR_TOOLS_DISABLE_WEB_FETCH already
 * used. Pure: no I/O. The env reaches the stdio child because the CLI spawns the
 * bridge with this env and the bridge forwards `{...process.env, ...stdioEnv}` to
 * its child (mcp-evolution-bridge.ts:293) — live-verified 2026-07-25.
 */
export function buildArToolsMcpConfig(paths: ArToolsPaths, opts: ArToolsMcpConfigOpts = {}): ArToolsMcpConfig {
  // BOUNDARY-ish: the fail-open inversion is severe enough (an empty subset would
  // grant the FULL tool surface, run_command included) that it is refused loudly
  // rather than normalised. A caller reaching here with "" has a bug upstream.
  if (opts.toolsSubset === "") {
    throw new Error(
      "buildArToolsMcpConfig: toolsSubset must not be the empty string — ar-tools reads an " +
        "empty TOOLS as UNSET and registers every tool including run_command (server.ts:41). " +
        "Pass MCP_TOOLS_NONE to register nothing, or omit toolsSubset for the full surface.",
    );
  }

  const env: Record<string, string> = {};
  if (opts.toolsSubset !== undefined) env.TOOLS = opts.toolsSubset;
  if (opts.disableWebFetch) env.AR_TOOLS_DISABLE_WEB_FETCH = "1";

  // Launch the bridge AND its downstream stdio child via the running node + tsx
  // loader directly, NOT `npx tsx` — byte-mirrors container-manager.ts:1706-1712.
  // `npx` re-resolves the tsx bin on every spawn (~1.6s cold on Windows) and the
  // evolve chain pays it TWICE, opening a ~3s window in which a fresh per-message
  // `claude -p` worker emits its first tool call before tools/list has registered:
  // "No such tool available: mcp__ar-tools__*". container-manager learned this and
  // switched; this synthesis site kept the old `npx tsx` shape and so reproduced
  // the cold-start race on every tools:'ar-tools' spawn (genesis e394bebd — the
  // litmus's own reply reported only the default Claude Code tools).
  // process.execPath is machine-specific and resolved fresh per spawn — the config
  // is written to a temp file and deleted, never persisted into a workspace.json.
  const nodeBin = process.execPath;
  const server: ArToolsMcpConfig["mcpServers"]["ar-tools"] = {
    command: nodeBin,
    args: [
      "--import",
      "tsx",
      paths.evolutionBridgePath,
      "--cmd",
      nodeBin,
      "--args",
      `--import,tsx,${paths.stdioServerPath}`,
      "--dir",
      paths.genomeDir,
    ],
  };
  // Omitted entirely when empty so the no-options config stays byte-identical to
  // the pre-envelope shape (the existing unit test asserts that exact object).
  if (Object.keys(env).length > 0) server.env = env;

  return { mcpServers: { "ar-tools": server } };
}


/** Same as buildArToolsMcpConfig but sets AR_TOOLS_DISABLE_WEB_FETCH=1 on the stdio child. */
export function buildArToolsLocalMcpConfig(paths: ArToolsPaths, opts: ArToolsMcpConfigOpts = {}): ArToolsMcpConfig {
  return buildArToolsMcpConfig(paths, { ...opts, disableWebFetch: true });
}


// ── Disallowed-tools lists ────────────────────────────────────────────────────
//
// Duplicated (NOT imported) from claude-worker-loader.mjs so this stays a pure
// `.ts` module that typechecks under strict+Node16 (importing the `.mjs` would
// need a `.d.mts` that doesn't exist → TS7016). The duplication is drift-guarded
// in agent-run-tools.test.ts, which imports the canonical GROK_ALWAYS_DISALLOWED
// / GROK_BUILTIN_DISALLOWED (identical lists) and deep-equals them against these.

/** Interactive / supervisor-owned tools that can't render or that schedule
 *  colliding future turns in a headless `-p` run. Blocked for every ar-tools
 *  worker. Mirror of claude-worker-loader.mjs:67-71 (alwaysBlock). */
export const CLAUDE_ALWAYS_BLOCK = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "PushNotification",
  "ScheduleWakeup",
  "Monitor",
  "CronCreate",
  "CronDelete",
  "CronList",
];

/** Built-in file/shell/web tools replaced by the ar-tools MCP equivalents — so
 *  every call flows through MCP (and the evolution bridge observes it). Mirror of
 *  claude-worker-loader.mjs:78 (builtinBlock). */
export const CLAUDE_BUILTIN_BLOCK = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
];

/** The 18-name deduped disallowed list an ar-tools worker runs with (interactive
 *  block + built-in block). Mirror of claude-worker-loader.mjs:80's
 *  combinedDisallowed with no per-agent toolRouter list (agent:run has none). */
export function buildClaudeDisallowedTools(): string[] {
  return [...new Set([...CLAUDE_ALWAYS_BLOCK, ...CLAUDE_BUILTIN_BLOCK])];
}

// ── grok config + flags ───────────────────────────────────────────────────────

/** TOML basic-string escape — backslash and double-quote. Reimplements
 *  grok-worker-loader.mjs:200-203 (mandatory: Windows paths are backslash-laden). */
function tomlStr(s: string): string {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Build the `<cwd>/.grok/config.toml` body that makes grok auto-discover the
 * ar-tools MCP server (grok-worker-loader.mjs:180-181,218-227,244). Same stdio
 * command/args as the claude `--mcp-config`, emitted in grok's TOML schema.
 */
export function buildGrokConfigToml(paths: ArToolsPaths, opts: ArToolsMcpConfigOpts = {}): string {
  return serverToToml(buildArToolsMcpConfig(paths, opts).mcpServers["ar-tools"]);
}

/** Render one ar-tools server entry (command/args/enabled + optional env table) as
 *  grok's TOML. Shared by both variants so the env seam — which now carries the
 *  envelope's TOOLS subset, not just AR_TOOLS_DISABLE_WEB_FETCH — cannot be wired
 *  on one path and forgotten on the other. */
function serverToToml(server: ArToolsMcpConfig["mcpServers"]["ar-tools"]): string {
  const lines = [
    `[mcp_servers.${tomlStr("ar-tools")}]`,
    `command = ${tomlStr(server.command)}`,
    `args = [${server.args.map(tomlStr).join(", ")}]`,
    "enabled = true",
  ];
  if (server.env) {
    lines.push(`[mcp_servers.${tomlStr("ar-tools")}.env]`);
    for (const [k, v] of Object.entries(server.env)) {
      lines.push(`${k} = ${tomlStr(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * grok headless tool-control flags for MCP-only mode. Mirrors
 * appendGrokHeadlessToolFlags (grok-disallowed-tools.mjs:71-82) with
 * disableBuiltinTools active: the 18-name disallowed list (identical to grok's
 * GROK_ALWAYS + GROK_BUILTIN), plus --disable-web-search and --no-subagents.
 */

/** Grok config.toml for ar-tools-local (no web_fetch). */
export function buildGrokLocalConfigToml(paths: ArToolsPaths, opts: ArToolsMcpConfigOpts = {}): string {
  return serverToToml(buildArToolsLocalMcpConfig(paths, opts).mcpServers["ar-tools"]);
}

/**
 * grok headless tool-control flags. Mirrors appendGrokHeadlessToolFlags
 * (grok-disallowed-tools.mjs:71-82) with disableBuiltinTools active.
 *
 * `disallowedTools` is the ENVELOPE's computed deny-list. Passing it is what gives
 * runtime:"grok" the same deny-by-default as claude — otherwise the hole simply
 * moves to grok. Omitted → the legacy 18-name list, preserved so the pre-envelope
 * call shape (and its test) still behaves identically.
 *
 * `--disable-web-search` is dropped when the envelope grants `web`: keeping it
 * would silently contradict a granted capability, which is exactly the kind of
 * quiet downgrade the audit line could not explain.
 */
export function buildGrokToolFlags(disallowedTools?: string, grantsWeb = false): string[] {
  const disallowed = disallowedTools ?? buildClaudeDisallowedTools().join(",");
  const flags = ["--disallowed-tools", disallowed];
  if (!grantsWeb) flags.push("--disable-web-search");
  // Subagent spawning is capability escape by delegation — a no-shell grok worker
  // could otherwise ask a child for the shell. Never conditional.
  flags.push("--no-subagents");
  return flags;
}

// ── argv builders (extracted verbatim from agent-run.ts's spawn literals) ──────

/** Options for buildClaudeArgs. sessionId/model are truthy-gated exactly as the
 *  original runClaude literals; ar-tools flags append strictly at the end. */
export interface ClaudeArgsOpts {
  skipPerms: boolean;
  sessionId?: string;
  model?: string;
  /** Path to the written --mcp-config JSON (ar-tools mode only). */
  mcpConfigPath?: string;
  /** Comma-joined --disallowedTools list (ar-tools mode only). */
  disallowedTools?: string;
}

/**
 * Build the `claude -p` argv. The first four flags + skipPerms/resume/model are
 * transcribed verbatim from agent-run.ts:175-178 (order preserved). The two
 * ar-tools flags are appended strictly at the end and only when provided — so
 * the non-tools argv is byte-identical to the pre-change literal.
 */
export function buildClaudeArgs(opts: ClaudeArgsOpts): string[] {
  const args = ["-p", "-", "--output-format", "json"];
  if (opts.skipPerms) args.push("--dangerously-skip-permissions");
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  // ── ar-tools opt-in (appended last; absent → argv unchanged) ──
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.disallowedTools) args.push("--disallowedTools", opts.disallowedTools);
  return args;
}

/** Options for buildGrokArgs. promptFile is required (grok reads the prompt from
 *  a temp file); toolFlags append strictly at the end (ar-tools mode only). */
export interface GrokArgsOpts {
  skipPerms: boolean;
  promptFile: string;
  model?: string;
  sessionId?: string;
  /** ar-tools headless flags from buildGrokToolFlags() (ar-tools mode only). */
  toolFlags?: string[];
}

/**
 * Strict allowlist for the workflow params that reach the grok argv (`model`,
 * `sessionId`). These are interpolated from UPSTREAM NODE OUTPUT — untrusted at
 * this boundary. The win32 grok spawn can go through cmd.exe (shell:true whenever
 * only a bare name / .cmd shim resolves — issue #648), and Node re-joins argv into
 * ONE command line with NO quoting there, so `x" & calc & rem` executes arbitrary
 * commands. Every legitimate value passes (grok model ids like `grok-4.5-fast`,
 * CLI session ids); anything carrying whitespace or shell metacharacters throws.
 * The claude path needs no such gate — it spawns an argv array, never a shell.
 */
export function assertGrokSpawnParam(kind: "model" | "sessionId", value: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(
      `agent:run(grok): ${kind} failed strict validation (allowed: A-Za-z0-9._:-) — ` +
        `workflow params are interpolated from upstream node output and the win32 grok spawn ` +
        `may run through cmd.exe where they would reach the command line unescaped (issue #648): ` +
        JSON.stringify(value.slice(0, 80)),
    );
  }
}

/**
 * Build the `grok` argv. The base flags + model/resume are transcribed verbatim
 * from agent-run.ts:265-273 (order preserved). ar-tools toolFlags append strictly
 * at the end and only when provided — non-tools argv is byte-identical to the
 * pre-change literal.
 */
export function buildGrokArgs(opts: GrokArgsOpts): string[] {
  const args = [
    "--permission-mode",
    opts.skipPerms ? "bypassPermissions" : "askUser",
    "--output-format",
    "streaming-json",
    "--no-auto-update",
    "--no-alt-screen",
    "--prompt-file",
    opts.promptFile,
  ];
  if (opts.model) { assertGrokSpawnParam("model", opts.model); args.push("--model", opts.model); }
  if (opts.sessionId) { assertGrokSpawnParam("sessionId", opts.sessionId); args.push("--resume", opts.sessionId); }
  // ── ar-tools opt-in (appended last; absent → argv unchanged) ──
  if (opts.toolFlags && opts.toolFlags.length) args.push(...opts.toolFlags);
  return args;
}
