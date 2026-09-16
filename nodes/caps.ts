/**
 * Capability layer — turns the supervisor's deps (ContainerManager, the send +
 * reset-session handlers) into the injectable NodeCaps a node sees as `ctx.caps`.
 * This is the ONE place node primitives reach supervisor internals; node modules
 * stay pure and test with a mock caps object.
 *
 * WorkflowDeps lives here (not in a separate handlers module) because caps are the
 * sole consumer of those deps now that every handler is a contract node.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContainerManager } from "../../container-manager.js";
import type { SendHandler, ResetSessionHandler } from "../../http-api.js";
import { log } from "../../logger.js";
import type { WorkflowOutputStore } from "../output-store.js";
import { loadOrBuildIndex, resolveConventions } from "../conventions/resolve.js";
import type { AgentState, ConventionCaps, CorrectionsCaps, NodeCaps, ReceiptCaps, RunControlCaps, WorkflowInvoker } from "./contract.js";
import { NOOP_WORKFLOW_INVOKER } from "./contract.js";
import { NOOP_RUN_CONTROL, NOOP_RECEIPT_CAPS } from "../run-control.js";

const CAPS_DIR = dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = resolve(CAPS_DIR, "..", "..", "..");

/** What the node library needs from the supervisor to build its capabilities. */
export interface WorkflowDeps {
  cm: ContainerManager;
  onSend?: SendHandler;
  onResetSession?: ResetSessionHandler;
  /** Runner-only: extra definition directories loaded AFTER the built-ins (last
   *  write wins). Lets tests own their fixture blueprints instead of resurrecting
   *  removed ones under src/workflows/definitions/ (which the Definitions UI lists). */
  extraDefinitionsDirs?: string[];
}

/** ledger name → safe filename (no path traversal, no odd chars). */
function safeName(name: string): string {
  return (name || "ledger").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0).length;
}

export function buildCaps(
  deps: WorkflowDeps,
  dataDir: string,
  outputStore?: WorkflowOutputStore,
  runControl?: RunControlCaps,
  workflowInvoker?: WorkflowInvoker,
  receiptCaps?: ReceiptCaps,
): NodeCaps {
  const { cm, onSend, onResetSession } = deps;
  const ledgerDir = resolve(dataDir || process.cwd(), "data", "node-ledgers");

  const indexRef = {
    current: loadOrBuildIndex(MONOREPO_ROOT),
    repoRoot: MONOREPO_ROOT,
    rebuild: () => loadOrBuildIndex(MONOREPO_ROOT),
  };
  const conventions: ConventionCaps = {
    async resolve(cwd, _taskText) {
      try {
        return await resolveConventions(indexRef, cwd);
      } catch (err) {
        log("warn", "conventions_resolve_failed", { error: String(err), cwd });
        return { cwd, resolvedPackageDir: null, matched: [], empty: true };
      }
    },
  };

  // ── Experience-memory seam (Slice 5) — dynamic import mirroring runner.ts
  // loadCirculation: EM is a pure lib linked via root file: dep; if the link or
  // the store is broken we warn and return honest-empty, never fail a dispatch.
  // PATH CONTRACT: dataDir IS <root>/data at runtime (run-store.ts:L129-130) —
  // do NOT re-append "data" (the ledgerDir line above carries that latent
  // double-data bug; node-ledgers has simply never fired live to expose it).
  // The beat CLI writes <root>/data/experience-memory/corrections — this must
  // resolve to the SAME dir or the seam reads a store the beat never fills.
  const correctionsDir = resolve(dataDir || process.cwd(), "experience-memory", "corrections");
  const corrections: CorrectionsCaps = {
    async resolve(sig) {
      try {
        const em = (await import("@agentruntime/experience-memory")) as {
          resolveCorrections: (
            ref: { dir: string },
            s: { taskFamily: string; packageDir: string; executor: { runtime: string; model: string }; promptSketch: string },
          ) => Promise<{ matched: unknown[]; matchMode: "embedding" | "lexical" | "none"; empty: boolean }>;
          formatCorrectionsPreamble: (bundle: never) => string;
          canonicalizePackageDir: (cwd: string) => string;
        };
        const bundle = await em.resolveCorrections(
          { dir: correctionsDir },
          {
            taskFamily: sig.taskFamily,
            packageDir: em.canonicalizePackageDir(sig.packageDir),
            executor: { runtime: sig.runtime, model: sig.model },
            promptSketch: sig.promptSketch,
          },
        );
        const preamble = em.formatCorrectionsPreamble(bundle as never);
        return { preamble, empty: bundle.empty, matchMode: bundle.matchMode, count: bundle.matched.length };
      } catch (err) {
        log("warn", "corrections_resolve_failed", { error: String(err), taskFamily: sig.taskFamily });
        return { preamble: "", empty: true, matchMode: "none", count: 0 };
      }
    },
  };

  return {
    // Cancellation + run-mode channel. Falls back to an inert null object when no
    // runner is wired (unit tests), so nodes never branch on "is control attached?".
    run: runControl ?? NOOP_RUN_CONTROL,
    // Nested-workflow invocation channel (workflow:run). Falls back to an inert
    // null object that throws when no runner is wired (unit tests).
    workflow: workflowInvoker ?? NOOP_WORKFLOW_INVOKER,
    // Epistemic receipt capture — no-ops when no runner is wired (unit tests).
    receipt: receiptCaps ?? NOOP_RECEIPT_CAPS,
    async whisper(agent, message) {
      if (!onSend) throw new Error("whisper: no send handler configured — cannot reach agents");
      const c = cm.get(agent);
      if (!c) throw new Error(`whisper: unknown agent "${agent}"`);
      if (c.status !== "running") throw new Error(`whisper: agent "${agent}" is not running (status: ${c.status})`);
      return onSend(message, agent);
    },

    notify(agent, message) {
      if (!onSend) throw new Error("notify: no send handler configured — cannot reach agents");
      const c = cm.get(agent);
      if (!c) throw new Error(`notify: unknown agent "${agent}"`);
      if (c.status !== "running") return { dispatched: false, reason: `agent "${agent}" is not running (status: ${c.status})` };
      // Fire-and-forget: enqueue the whisper but DO NOT await the recipient reading
      // it. onSend() AWAITS the reply, which times out the node when the recipient
      // is busy (the live exec-notify failure). A notification must not block the
      // run on the recipient — dispatch and move on.
      void onSend(message, agent).catch((e) => log("warn", "notify_dispatch_failed", { agent, error: String(e) }));
      return { dispatched: true };
    },

    agentState(agent): AgentState | undefined {
      const c = cm.get(agent);
      if (!c) return undefined;
      const s = c.stats();
      return {
        name: agent,
        status: c.status,
        isProcessing: c.isProcessing,
        messagesHandled: s.messagesHandled ?? 0,
        uptimeMs: c.startedAt ? Date.now() - c.startedAt : 0,
      };
    },

    ledgerAppend(ledger, row) {
      mkdirSync(ledgerDir, { recursive: true });
      const file = join(ledgerDir, `${safeName(ledger)}.jsonl`);
      appendFileSync(file, JSON.stringify({ ...row, ts: Date.now() }) + "\n");
      return countLines(file);
    },

    ledgerRead(ledger) {
      const file = join(ledgerDir, `${safeName(ledger)}.jsonl`);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
        })
        .filter((r): r is Record<string, unknown> => r !== null);
    },

    // Cast the level: the contract takes a free `string`; the logger takes a
    // LogLevel union. Unknown levels fall through the logger's own handling.
    log: (level, event, data) => log(level as Parameters<typeof log>[0], event, data),

    streamOutput: (correlationId, nodeId, chunk) => {
      outputStore?.append(correlationId, nodeId, chunk);
    },

    registerOutputFile: (correlationId, nodeId, path) => {
      outputStore?.registerFile(correlationId, nodeId, path);
    },

    // ── Container lifecycle (the migrated supervisor:* nodes) ────────────────
    supervisor: {
      cancel(name) {
        const c = cm.get(name);
        if (!c) throw new Error(`Container "${name}" not found`);
        return { cancelled: c.cancelCurrentRequest() };
      },

      resetConversation(name, hasArtifact) {
        const c = cm.get(name);
        if (!c) throw new Error(`Container "${name}" not found`);
        const previousSession = (c as unknown as { _sessionId: string | null })._sessionId ?? null;
        c.resetConversation(hasArtifact);
        log("info", "workflow_reset_conversation", { container: name, previousSession, hasArtifact });
        return { ok: true, previousSession };
      },

      clearSessionFile(name) {
        onResetSession?.(name);
        return { ok: true };
      },

      flushStats() {
        cm.flushStats();
        return { ok: true };
      },

      async send(name, message) {
        const c = cm.get(name);
        if (!c) throw new Error(`Container "${name}" not found`);
        if (c.status !== "running") {
          log("warn", "workflow_send_skipped", { container: name, status: c.status });
          return { sent: false, reason: `Container status: ${c.status}` };
        }
        if (!onSend) throw new Error("No send handler configured");
        // Fire-and-forget, same as notify() above and as SupervisorCaps.send has
        // always DECLARED. The old `await onSend(...)` awaited the recipient's whole
        // turn, so `anchor` in new-session-oriented timed out at 120s while the agent
        // it had just anchored worked for 20 minutes (wf-1785473994222, 2026-07-31) —
        // the run went red and the turn was orphaned. `sent:true` means ENQUEUED.
        void onSend(message, name).catch((e) => log("warn", "workflow_send_dispatch_failed", { container: name, error: String(e) }));
        return { sent: true };
      },

      async start(name) {
        const result = await cm.start(name);
        return { ok: true, result };
      },

      async stop(name) {
        const result = await cm.stop(name);
        return { ok: true, result };
      },
    },
    conventions,
    corrections,
  };
}
