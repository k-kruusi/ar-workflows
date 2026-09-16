/**
 * runOpencode — agent:run's `opencode` runtime leg (Ox Alpha via opencode.ai).
 *
 * Runs the opencode CLI headless through the SAME worker-loader OpenCodeAdapter
 * uses (src/opencode-worker-loader.mjs) instead of spawning it directly like
 * runGrok: binary resolution (.exe, no shell), long-prompt --file delivery, the
 * stdin-must-end hang, NDJSON event parsing and session resume are all solved
 * and live-verified there once (2026-08-21, opencode 1.18.21). Forking a second
 * parser here would be two code paths claiming one wire format.
 *
 * Scope cut, stated honestly: this leg does NOT bridge the MCP mesh into the
 * worker (no ar-tools envelope wiring — the loader supports mcpServers but
 * agent:run's envelope→bridge glue is claude/grok-shaped today). Workers get
 * opencode's built-in tools. Add mesh bridging only when a workflow needs it.
 *
 * Usage fields are optional-honest per AgentRunUsage: present only when the CLI
 * reported them; model is omitted entirely when no explicit model was requested
 * (never fabricate attribution).
 */

import { Worker } from "node:worker_threads";
import { treeKill } from "../../tree-kill.js";
import type { AgentRunChildHooks, AgentRunUsage } from "./agent-run.js";

const WORKER_PATH = new URL("../../opencode-worker-loader.mjs", import.meta.url);

/** Same non-interaction contract OpenCodeAdapter imposes on chat turns. */
const HEADLESS_PREAMBLE = [
  "[HEADLESS NON-INTERACTIVE MODE]",
  "You are running headless inside AgentRuntime via `opencode run` — no human is watching a TUI.",
  "Ask any questions as plain chat text; never block on interactive prompts or approval flows.",
  "If a tool call fails, report the concrete error. Verify actions (e.g. read back a file you wrote) before claiming success.",
  "---",
  "",
].join("\n");

export interface RunOpencodeOpts {
  prompt: string;
  cwd: string;
  sessionId?: string | null;
  model?: string | null;
  skipPerms?: boolean;
  childHooks?: AgentRunChildHooks;
}

interface LoaderDoneMessage {
  type: "done";
  ok: boolean;
  text?: string;
  sessionId?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  error?: string;
  exitCode?: number | null;
}

/** Map the loader's snake_case usage block onto agent:run's optional-honest shape.
 *  Fields absent on the wire stay absent here — never a fabricated zero. */
function loaderUsageToAgentRunUsage(
  usage: NonNullable<LoaderDoneMessage["usage"]> | null | undefined,
): AgentRunUsage | undefined {
  if (!usage) return undefined;
  const out: AgentRunUsage = {};
  if (typeof usage.input_tokens === "number") out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") out.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") out.cacheReadTokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number")
    out.cacheCreationTokens = usage.cache_creation_input_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** "xai/grok-4.5" → "grok-4.5"; bare ids pass through unchanged. */
function bareModelId(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx === -1 ? model : model.slice(idx + 1);
}

export function runOpencode(opts: RunOpencodeOpts): Promise<{
  text: string;
  sessionId: string | null;
  usage?: AgentRunUsage;
}> {
  // Boundary validation: prompt/sessionId/model arrive via workflow templates,
  // i.e. potentially upstream node OUTPUT. argv-array spawning means no shell
  // injection is possible, but a value beginning with "-" could smuggle an
  // extra flag into the CLI invocation. Reject at the boundary, assert inside.
  if (!opts.prompt || !opts.prompt.trim()) {
    return Promise.reject(new Error("runOpencode: empty prompt — nothing to ask the worker"));
  }
  if (opts.sessionId && opts.sessionId.startsWith("-")) {
    return Promise.reject(
      new Error(`runOpencode: sessionId must be an id, got flag-shaped "${opts.sessionId.slice(0, 24)}"`)
    );
  }
  if (opts.model && opts.model.startsWith("-")) {
    return Promise.reject(
      new Error(`runOpencode: model must be provider/model, got flag-shaped "${opts.model.slice(0, 24)}"`)
    );
  }

  const hooks = opts.childHooks ?? {};
  const { correlationId, nodeId, recordChild, clearChild, signal } = hooks;

  return new Promise((resolve, reject) => {
    let settled = false;
    let childPid: number | null = null;
    let pendingKill = false;

    const commandSig =
      `opencode run${opts.model ? ` --model ${opts.model}` : ""}${opts.skipPerms ? " --auto" : ""}`;

    const worker = new Worker(WORKER_PATH, {
      workerData: {
        message: HEADLESS_PREAMBLE + opts.prompt,
        sessionId: opts.sessionId ?? undefined,
        cwd: opts.cwd,
        model: opts.model && opts.model.trim() ? opts.model : undefined,
        autoApprove: !!opts.skipPerms,
      },
    });

    const killChildTree = (): void => {
      if (childPid === null) {
        // pid not reported yet — the child_pid handler will honor pendingKill.
        pendingKill = true;
        return;
      }
      try {
        treeKill(childPid, "SIGKILL");
      } catch {
        // Best-effort during cancellation — same stance as OpenCodeAdapter.
      }
    };

    const unwire = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (correlationId && nodeId && clearChild) clearChild(correlationId, nodeId);
    };

    function onAbort(): void {
      if (settled) return;
      killChildTree();
      worker.terminate();
      fail(new Error("opencode run cancelled"));
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      worker.terminate();
      unwire();
      reject(err);
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    worker.on("message", (raw: unknown) => {
      const msg = raw as Record<string, unknown>;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "child_pid" && typeof msg.pid === "number") {
        childPid = msg.pid;
        if (correlationId && nodeId && recordChild) {
          recordChild(correlationId, nodeId, childPid, commandSig);
        }
        if (pendingKill) {
          try {
            treeKill(childPid, "SIGKILL");
          } catch {
            // best-effort
          }
        }
        return;
      }

      if (msg.type === "done") {
        const done = msg as unknown as LoaderDoneMessage;
        if (!done.ok) {
          fail(new Error(`opencode failed: ${done.error ?? `exit code ${done.exitCode ?? "unknown"}`}`));
          return;
        }
        const text = String(done.text ?? "").trim();
        if (!text) {
          // Honest Response: empty completion is not success with a placeholder label.
          fail(new Error("opencode completed with empty text — refusing silent success placeholder"));
          return;
        }
        settled = true;
        unwire();
        const usage = loaderUsageToAgentRunUsage(done.usage);
        // Attribution is honest here: we passed --model <id>, so the CLI ran it.
        // When no explicit model was requested, omit — never fabricate one.
        if (usage && opts.model && opts.model.trim()) usage.model = bareModelId(opts.model);
        resolve({
          text,
          sessionId: done.sessionId ?? opts.sessionId ?? null,
          usage,
        });
      }
    });

    worker.on("error", (err) => fail(err));

    worker.on("exit", (code) => {
      if (!settled) {
        // Unexpected exit without 'done' — silent failure, never an empty success.
        fail(
          new Error(
            code !== 0
              ? `opencode worker exited with code ${code} without reporting a result`
              : "opencode worker exited cleanly without reporting a result"
          )
        );
      }
    });
  });
}
