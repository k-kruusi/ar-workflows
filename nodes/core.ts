/**
 * Core primitives — pure nodes with no capabilities. The simplest examples of the
 * contract, and the building blocks every workflow reuses (delay for poll/watchdog
 * loops, gate for failure-edge branching).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { scrubSecrets } from "@agentruntime/secret-scrub";
import { spawnShellChild } from "../../proc-exec.js";
import { defineNode, type NodeDef } from "./contract.js";
import { summarizeIndependence, type IndependenceSummary } from "../epistemics.js";
import { getProcessCommandLine, killChildTree, killTreeByPid } from "../proc-kill.js";

/** Read an exec's exit sentinel — the durable outcome a wrapper writes even when
 *  no engine survives to see the close event. undefined = no outcome recorded. */
function readExitSentinel(exitFile: string): { exitCode: number } | undefined {
  try {
    const code = (JSON.parse(readFileSync(exitFile, "utf-8")) as { exitCode?: unknown }).exitCode;
    return typeof code === "number" ? { exitCode: code } : undefined;
  } catch {
    return undefined;
  }
}

/** Secrets-redact stdout/stderr (shared by the live close path and the resume paths). */
function scrubOut(
  stdout: string,
  stderr: string,
  doScrub: boolean,
): { stdout: string; stderr: string; scrubbed?: Record<string, number> } {
  if (!doScrub) return { stdout, stderr };
  const sout = scrubSecrets(stdout);
  const serr = scrubSecrets(stderr);
  const merged = new Map<string, number>();
  for (const h of [...sout.hits, ...serr.hits]) merged.set(h.kind, (merged.get(h.kind) ?? 0) + h.count);
  return { stdout: sout.text, stderr: serr.text, ...(merged.size > 0 ? { scrubbed: Object.fromEntries(merged) } : {}) };
}

/** A command-line signature shorter than this is too generic to safely
 *  distinguish from an unrelated process that recycled the pid. */
const MIN_CMD_SIG = 12;

export const coreNodes: NodeDef[] = [
  defineNode({
    type: "core:noop",
    description: "Does nothing; returns { ok:true }. Placeholder / join anchor.",
    run: async () => ({ ok: true }),
  }),

  defineNode({
    type: "core:merge",
    description:
      "Deterministic fan-in: concatenates named `parts` into one `text` (plus `present`/`missing` " +
      "rosters and `partCount`). Params: parts (object of label -> string, normally template-" +
      "interpolated from upstream node results), separator? (default a labelled '=== <label> ===' " +
      "block), requireAll? (default false — when true, a missing/empty part FAILS the node instead " +
      "of being rostered as missing), sources? (COMMA-SEPARATED node ids whose inferences this join " +
      "is accounting for — narrows the `independence` report to just those legs; omit when the run " +
      "IS the panel). ALSO RETURNS `independence`: how many distinct WEIGHT FAMILIES and distinct " +
      "SUPPLY CHAINS the joined verdicts actually came from — partCount tells you how many replies " +
      "arrived, independence tells you how many opinions they represent, and those are different " +
      "numbers whenever two legs share a model or a subscription. WHY THIS IS NOT AN agent:run: joining N independent verdicts " +
      "through a model collapses them into ONE model's opinion, destroying exactly the independence " +
      "a multi-model panel exists to buy. The join must be mechanical or the panel is theatre. " +
      "Also the reason a fan-in needs a node at all: workflow:run surfaces the TERMINAL node, so a " +
      "graph ending in N parallel nodes silently returns 1 of N.",
    run: async ({ inputs, caps, correlationId }) => {
      const parts = inputs.obj<Record<string, unknown>>("parts", { default: {} });
      const separator = inputs.has("separator") ? inputs.str("separator") : undefined;
      const requireAll = inputs.has("requireAll") ? inputs.bool("requireAll") : false;
      // Comma-separated, like agent:run's `capabilities` — the inputs contract
      // exposes no .arr, so an array input would be a fabrication (contract.ts).
      const sources = inputs.str("sources").split(",").map((s) => s.trim()).filter(Boolean);

      const present: string[] = [];
      const missing: string[] = [];
      const blocks: string[] = [];

      // Insertion order of `parts` is the author's declared order — stable across
      // runs, unlike completion order. A panel that reorders itself run-to-run is
      // not diffable, and diffing two panel runs is most of the value.
      for (const [label, raw] of Object.entries(parts)) {
        const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
        if (text.trim() === "") {
          missing.push(label);
          continue;
        }
        present.push(label);
        blocks.push(separator !== undefined ? `${separator}${label}\n${text}` : `=== ${label} ===\n${text}`);
      }

      // An absent part is LEGIBLE ABSENCE, never a silent gap: a reader (human or
      // downstream node) must be able to tell "kimi declined" from "kimi agreed".
      // Honest Response — a partial panel reported as whole is the failure mode.
      if (requireAll && missing.length > 0) {
        throw new Error(
          `core:merge: requireAll set but ${missing.length} part(s) empty/absent: ${missing.join(", ")} ` +
            `(present: ${present.join(", ") || "none"})`,
        );
      }

      // ── Independence accounting (invariant #3) ────────────────────────────
      // The reason this lives on the JOIN and not on the reviewers: the join is the
      // only place that sees the whole panel, and it is the node a parent DAG reads
      // via workflow:run. Without it, `partCount: 3, complete: true` reads identically
      // whether the three legs were three model families or one model called thrice —
      // the panel asserts its independence in prose and proves nothing.
      //
      // Omitted entirely (not zeroed) when there is no runner to ask: a fan-in that
      // could not measure must not report a number, or a downstream floor would read
      // "unmeasured" as "failed".
      const runNodes = correlationId ? caps.receipt.runNodes(correlationId) : undefined;
      let independence: (IndependenceSummary & { scope: "sources" | "run" }) | undefined;
      if (runNodes) {
        let scoped = runNodes;
        if (sources.length > 0) {
          // A named source that does not exist is an authoring error, and a silent
          // one would UNDER-count independence — the direction that makes a panel
          // look worse than it is, and then makes a floor gate fire on a lie.
          const unknownIds = sources.filter((id) => !(id in runNodes));
          if (unknownIds.length > 0) {
            throw new Error(
              `core:merge: sources names ${unknownIds.length} node id(s) not in this run: ${unknownIds.join(", ")} ` +
                `(known: ${Object.keys(runNodes).join(", ")})`,
            );
          }
          scoped = Object.fromEntries(sources.map((id) => [id, runNodes[id]]));
        }
        independence = {
          ...summarizeIndependence(scoped),
          // Names WHICH nodes were counted, so a consumer never has to guess whether
          // an unrelated infer node elsewhere in the DAG inflated the number.
          scope: sources.length > 0 ? "sources" : "run",
        };
      }

      return {
        text: blocks.join("\n\n"),
        present,
        missing,
        partCount: present.length,
        complete: missing.length === 0,
        ...(independence ? { independence } : {}),
      };
    },
  }),

  defineNode({
    type: "core:delay",
    description: "Sleeps for `ms` (clamped 0…600000), returns { sleptMs }. The repeat-delay primitive for poll/watchdog loops.",
    run: async ({ inputs }) => {
      const ms = inputs.num("ms", { default: 1000, min: 0, max: 600_000 });
      await new Promise((r) => setTimeout(r, ms));
      return { sleptMs: ms };
    },
  }),

  defineNode({
    type: "core:gate",
    description: "Passes iff `open` is truthy (or `sentinel` file exists); throws otherwise. Drives on:'failure' branching.",
    run: async ({ inputs }) => {
      const sentinel = inputs.str("sentinel");
      if (sentinel) {
        if (existsSync(sentinel)) return { open: true, sentinel };
        throw new Error(`core:gate closed: sentinel not found (${sentinel})`);
      }
      if (inputs.has("open")) {
        // FAIL CLOSED on an unresolved template. Interpolation leaves `{{a.b.c}}`
        // in place rather than erroring (deliberately — typos stay visible), and
        // inputs.bool() truthy-coerces any non-empty string. Together that made the
        // gate open on a typo: observed 2026-08-10, when a goal loop's settle_gate
        // read {{nodes.judge.result.structured.goalMet}} against a node that never
        // produced `structured`, coerced the literal braces to true, and shipped.
        // A gate that fails OPEN on a typo is worse than no gate — it launders a
        // mistake into an approval. `{{` is never a legitimate gate value.
        const rawOpen = inputs.raw("open");
        if (typeof rawOpen === "string" && rawOpen.includes("{{")) {
          throw new Error(
            `core:gate: "open" is an UNRESOLVED TEMPLATE (${rawOpen.slice(0, 120)}) — ` +
              `the referenced node or field does not exist. Refusing to treat it as true; ` +
              `check the node id and that the node actually returns that field.`,
          );
        }
        if (inputs.bool("open")) return { open: true };
        throw new Error("core:gate closed: open=false");
      }
      throw new Error('core:gate requires either "open" (boolean) or "sentinel" (file path)');
    },
  }),

  defineNode({
    type: "core:exec",
    description:
      "Runs a shell command (long-running OK — e.g. a Python GPU job). Returns { ok, exitCode, stdout, stderr }; a non-zero exit is a RESULT (ok:false), not a node failure. Throws only if the command cannot be spawned at all. Spawned shells run UTF-8 (Windows: `chcp 65001` + PYTHONUTF8/PYTHONIOENCODING) so a child's em-dash/box-drawing output isn't mojibaked. An over-long command (Windows ~8000 chars) is refused as ok:false BEFORE spawn — write it to a script file and run that. IMPORTANT: set the node's graph-level timeoutMs to exceed the script's duration — the engine's 30s default will otherwise kill it. Optional inputs: cwd, timeoutMs (self-kill the child, 0=none), maxOutputBytes (capture cap, default 1MB), logFile (OVERRIDE for the live-tail file — usually unneeded: when the command redirects its own stdout to a file (`… > run.log 2>&1`) that target is AUTO-DETECTED and tailed, since the captured pipe is then empty. Set logFile only to tail a different file, or when the command cd's before redirecting so its relative redirect won't resolve against this node's cwd. Prefer an ABSOLUTE path; a relative one resolves against cwd). CANCELLABLE: a cancelled run (POST /workflow/run/:id/cancel) tree-kills the child (win32 taskkill /T /F; posix process-group SIGKILL) and resolves { ok:false, cancelled:true } once the child is reaped (bounded by the node's timeoutMs if a kill somehow can't reap it) — not an unbounded hang. DURABLE OUTCOME + RESUME: inside the engine the spawn is wrapped so the exit code lands in a sentinel file (data/workflow-runs/<cid>.<node>.exit.json) even if the supervisor dies mid-run. On resume the node NEVER blindly re-executes: a present sentinel completes it (resumed:'completed-while-down', stdout recovered from the command's own redirect when there is one), a still-running child is ADOPTED (resumed:'adopted', PID-reuse-safe, poll until its sentinel — cancel/timeout still apply), and only a truly lost outcome re-runs. resume:'fail' (default 're-execute') refuses that re-run for non-idempotent commands, resolving { ok:false, resumeRefused:true } — declare it on any node whose command must never run twice. scrub (default true): scan stdout+stderr for secrets before returning; when hits are found the result gains a `scrubbed: { kind: count }` field. Set scrub:false only for commands whose output must be read verbatim (e.g. key-generation tools whose output IS the secret).",
    run: async ({ inputs, caps, correlationId, nodeId }) => {
      const command = inputs.str("command", { required: true });
      const cwd = inputs.str("cwd");
      const timeoutMs = inputs.num("timeoutMs", { default: 0, min: 0 });
      const maxOut = inputs.num("maxOutputBytes", { default: 1_000_000, min: 1024 });
      const logFile = inputs.str("logFile");
      const doScrub = inputs.bool("scrub", { default: true });
      // Identity suffix on error strings — turns a bare timeout/spawn-fail into a
      // line you can grep back to the exact run+node (BUG-009: timeouts carried no
      // diagnostics — hang vs crash was undiagnosable from the agent side).
      const where = correlationId && nodeId ? ` [run ${correlationId} / node ${nodeId}]` : "";

      // ── durable outcome + resume machinery ──────────────────────────────
      // A FRESH spawn wraps the command so its exit code lands in a sentinel
      // file even if this engine dies mid-run. A RESUMED node (a previous
      // engine recorded a child for it) never blindly re-executes:
      //   (a) sentinel exists      → the child finished while down; complete
      //                              from the file, no new process.
      //   (b) child still running  → ADOPT it: poll for its sentinel. Its work
      //                              is preserved, not killed-and-redone.
      //   (c) outcome truly lost   → resume:"fail" refuses re-execution (for
      //                              non-idempotent commands); default re-runs.
      const resumeFail = (inputs.str("resume") ?? "re-execute") === "fail";
      const stateDir = caps.run.execStateDir();
      const recorded = correlationId && nodeId ? caps.run.recordedChild(correlationId, nodeId) : undefined;
      const exitFile =
        stateDir && correlationId && nodeId ? resolve(stateDir, `${correlationId}.${nodeId}.exit.json`) : undefined;

      // The file the dashboard tails live. An explicit logFile wins; otherwise we
      // auto-detect the command's OWN stdout redirect (`… 1> run.log 2>&1`) so a job
      // that pipes itself to a file tails live without the author repeating the path.
      const tailFile = logFile || detectStdoutRedirect(command);
      if (tailFile && correlationId && nodeId) {
        caps.registerOutputFile(correlationId, nodeId, resolve(cwd || process.cwd(), tailFile));
      }

      // Build a result from a sentinel: exit code from the file, stdout recovered
      // from the command's own redirect when there is one (output produced while
      // no engine was attached is otherwise honestly absent — stderr unknown).
      const sentinelResult = (resumed: string, exitCode: number): Record<string, unknown> => {
        let stdout = "";
        if (tailFile) {
          try {
            const p = resolve(cwd || process.cwd(), tailFile);
            if (existsSync(p)) {
              const buf = readFileSync(p);
              stdout = buf.subarray(Math.max(0, buf.length - maxOut)).toString().trim();
            }
          } catch { /* output recovery is best-effort */ }
        }
        const out = scrubOut(stdout, "", doScrub);
        return { ok: exitCode === 0, exitCode, stdout: out.stdout, stderr: out.stderr, resumed, ...(out.scrubbed ? { scrubbed: out.scrubbed } : {}) };
      };

      if (recorded && exitFile && correlationId && nodeId) {
        // (a) the child finished while no engine was attached.
        const finished = readExitSentinel(exitFile);
        if (finished) {
          caps.run.clearChild(correlationId, nodeId);
          caps.log("info", "exec_completed_while_down", { correlationId, nodeId, exitCode: finished.exitCode });
          return sentinelResult("completed-while-down", finished.exitCode);
        }
        // (b) the child is STILL RUNNING — adopt it (PID-reuse-safe verify first:
        // the live process must still carry the recorded command signature).
        const live = getProcessCommandLine(recorded.pid);
        const sig = recorded.command.trim();
        if (live && sig.length >= MIN_CMD_SIG && live.includes(sig)) {
          caps.log("info", "exec_adopt_orphan", { correlationId, nodeId, pid: recorded.pid });
          return await new Promise<Record<string, unknown>>((resolveAdopt, rejectAdopt) => {
            let cancelled = false, timedOut = false, killedAt = 0;
            const signal = correlationId ? caps.run.signal(correlationId) : undefined;
            const onAbort = (): void => { cancelled = true; killedAt = Date.now(); killTreeByPid(recorded.pid); };
            if (signal) {
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort);
            }
            const timer =
              timeoutMs > 0
                ? setTimeout(() => { timedOut = true; killedAt = Date.now(); killTreeByPid(recorded.pid); }, timeoutMs)
                : null;
            const settle = (fn: () => void): void => {
              clearInterval(poll);
              if (timer) clearTimeout(timer);
              if (signal) signal.removeEventListener("abort", onAbort);
              fn();
            };
            const poll = setInterval(() => {
              const doneEarly = readExitSentinel(exitFile);
              if (doneEarly) {
                settle(() => {
                  caps.run.clearChild(correlationId, nodeId);
                  resolveAdopt(sentinelResult("adopted", doneEarly.exitCode));
                });
                return;
              }
              if (cancelled || timedOut) {
                // The kill makes the wrapper die before writing its sentinel; a
                // short grace covers a child that finished as we killed it.
                if (Date.now() - killedAt > 5000) {
                  settle(() => {
                    caps.run.clearChild(correlationId, nodeId);
                    if (timedOut) rejectAdopt(new Error(`core:exec: adopted child exceeded timeoutMs=${timeoutMs} and was killed${where}`));
                    else resolveAdopt({ ok: false, cancelled: true, exitCode: -1, stdout: "", stderr: "", resumed: "adopted" });
                  });
                }
                return;
              }
              if (!getProcessCommandLine(recorded.pid)) {
                // The child died without writing a sentinel (host crash, OOM) —
                // the outcome is lost; settle per the resume policy.
                settle(() => {
                  caps.run.clearChild(correlationId, nodeId);
                  if (resumeFail) {
                    resolveAdopt({ ok: false, resumeRefused: true, exitCode: -1, stdout: "", stderr: `core:exec: adopted child died without an outcome and resume:"fail" forbids re-execution${where}` });
                  } else {
                    resolveAdopt(spawnFresh());
                  }
                });
              }
            }, 2000);
          });
        }
        // (c) outcome lost (pid dead or recycled, no sentinel) — but re-check
        // the sentinel FIRST: the cmdline probe is slow (a CIM query), and the
        // child may have finished and written its outcome DURING it. Treating
        // that as "lost" would re-execute work that actually completed.
        const finishedLate = readExitSentinel(exitFile);
        if (finishedLate) {
          caps.run.clearChild(correlationId, nodeId);
          caps.log("info", "exec_completed_while_down", { correlationId, nodeId, exitCode: finishedLate.exitCode });
          return sentinelResult("completed-while-down", finishedLate.exitCode);
        }
        if (resumeFail) {
          caps.run.clearChild(correlationId, nodeId);
          return {
            ok: false,
            resumeRefused: true,
            exitCode: -1,
            stdout: "",
            stderr: `core:exec: the outcome was lost in a supervisor restart and resume:"fail" forbids re-execution${where}`,
          };
        }
        // default: fall through to a fresh spawn.
      }

      // A fresh spawn, SELF-CONTAINED in a hoisted function declaration: the
      // resume path's adoption fallback (poll callback, fires long after this
      // body returned) must be able to call it, and const bindings from this
      // body would be in the temporal dead zone at that point.
      async function spawnFresh(): Promise<Record<string, unknown>> {
        // Guard an over-long command BEFORE spawn. A Windows shell command line caps
        // near 8191 chars (the `cmd /d /s /c "…"` wrapper eats a few more); overshoot
        // it and the spawn fails hard — the ~8KB exec that took Chris's whole runtime
        // down (BUG-001). Return a clean ok:false RESULT (not a throw), so a downstream
        // whisper (exec-notify) still delivers the diagnosis instead of the run
        // silently dying. The remedy is always the same: write it to a script and run
        // the file.
        const MAX_COMMAND_CHARS = process.platform === "win32" ? 8000 : 120_000;
        if (command.length > MAX_COMMAND_CHARS) {
          caps.log("warn", "exec_command_too_long", { length: command.length, limit: MAX_COMMAND_CHARS, correlationId, nodeId });
          return {
            ok: false,
            exitCode: -1,
            stdout: "",
            stderr: `core:exec: command too long — ${command.length} chars exceeds the ${MAX_COMMAND_CHARS}-char limit for ${process.platform}. Write it to a script file and run that instead.${where}`,
          };
        }

        // Live: stream each chunk to the run-node output buffer so the dashboard can
        // tail it WHILE the node runs (not just the final result). No-op if the
        // engine didn't supply identity or no output store is wired.
        const sink = (chunk: string) => {
          if (correlationId && nodeId) caps.streamOutput(correlationId, nodeId, chunk);
        };

        // Force UTF-8 on the child (BUG-007: a spawned Windows shell defaults to the
        // OEM code page, so a child's UTF-8 bytes — em-dash, box-drawing — arrive
        // mojibaked). PYTHONUTF8/PYTHONIOENCODING make Python (the common GPU-job
        // runtime) emit UTF-8 regardless of the console code page; on Windows we also
        // prefix `chcp 65001` so cmd built-ins and most native tools emit UTF-8. The
        // captured bytes are then correctly decoded as UTF-8 (Buffer#toString default).
        const childEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

        // The spawn string, with the exit sentinel wired in when we're inside the
        // engine (stateDir known). A stale sentinel from a previous attempt is
        // deleted FIRST — it must never be read as THIS attempt's outcome. win32
        // needs a wrapper .cmd because %ERRORLEVEL% only expands per-line in a
        // batch file (inline `& echo %ERRORLEVEL%` expands at parse time, before
        // the command runs); posix appends the printf inline. A multi-line command
        // can't live in a .cmd line — it takes the legacy spawn (no sentinel).
        let spawnCommand = process.platform === "win32" ? `chcp 65001>nul & ${command}` : command;
        if (exitFile) {
          try { rmSync(exitFile, { force: true }); } catch { /* no stale sentinel — fine */ }
          if (!command.includes("\n")) {
            try {
              mkdirSync(stateDir!, { recursive: true });
              if (process.platform === "win32") {
                const wrapFile = resolve(stateDir!, `${correlationId}.${nodeId}.wrap.cmd`);
                // The wrapper must EXIT with the command's code — without the
                // final exit /b the wrapper's own code is the echo's (always 0).
                writeFileSync(
                  wrapFile,
                  `@echo off\r\nchcp 65001>nul\r\n${command}\r\nset EC=%ERRORLEVEL%\r\n> "${exitFile}" echo {"exitCode": %EC%}\r\nexit /b %EC%\r\n`,
                );
                spawnCommand = `"${wrapFile}"`;
              } else {
                spawnCommand = `${command}; ec=$?; printf '{"exitCode": %s}' "$ec" > '${exitFile}'; exit $ec`;
              }
            } catch {
              caps.log("warn", "exec_sentinel_wrap_failed", { correlationId, nodeId, note: "legacy spawn — no durable outcome for this node" });
            }
          }
        }

        // The run's cancel signal (undefined outside the engine, or when no runner is
        // wired). When it fires we tree-kill the child and resolve as a cancelled RESULT
        // — never a hang. See run-control.ts: the task-graph engine has no cancel of its
        // own, so cancellation is cooperative and this is where it bites.
        const signal = correlationId ? caps.run.signal(correlationId) : undefined;

        return await new Promise<Record<string, unknown>>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let cancelled = false;
        let child: ChildProcess;
        try {
          // posix: spawn detached so the child leads its own process group — that's
          // what makes killChildTree's negative-pid signal a real TREE kill (a GPU job
          // launched via a shell has grandchildren). win32 does NOT get detached (it
          // would pop a new console); there, taskkill /T handles the tree.
          // The command is a workflow-author SHELL line by contract — the shell:true
          // lives in proc-exec.spawnShellChild (the audited escape hatch).
          child = spawnShellChild(spawnCommand, {
            cwd: cwd || undefined,
            env: childEnv,
            detached: process.platform !== "win32",
          });
        } catch (err) {
          // Synchronous spawn failure (e.g. EPERM / E2BIG on a pathological command,
          // BUG-006). Log the offending length and reject with a rich, greppable
          // message — the contract's "throws only if it cannot spawn at all". The
          // reject is caught by the runner (execGraph .catch), so it can never
          // become an uncaught throw that takes the supervisor down.
          const m = err instanceof Error ? err.message : String(err);
          caps.log("error", "exec_spawn_failed", { phase: "sync", error: m, length: command.length, correlationId, nodeId });
          reject(new Error(`core:exec: failed to spawn command — ${m} (command length ${command.length})${where}`));
          return;
        }
        // Record the spawned child so a resume can ADOPT it after a supervisor
        // restart (persisted via the run-store). The signature is the SPAWN string:
        // with a wrapper .cmd the live cmdline carries the wrapper path (unique per
        // run+node); inline spawns carry the command itself. Either way the resume
        // path PID-reuse-checks the live process's cmdline against it before adopting.
        if (correlationId && nodeId && child.pid) {
          caps.run.recordChild(correlationId, nodeId, child.pid, spawnCommand);
        }

        // Cooperative cancel: when the run's signal fires, tree-kill the child now.
        // The kill makes the child's own `close` fire, which resolves the RESULT below
        // as { cancelled:true } — not a hang, not a throw (see contract/card).
        const onAbort = (): void => { cancelled = true; killChildTree(child); };
        if (signal) {
          if (signal.aborted) onAbort();               // cancelled between node start and spawn
          else signal.addEventListener("abort", onAbort);
        }

        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                // Tree kill — a bare child.kill reaches only the shell wrapper, leaving
                // the real job (e.g. a python GPU process) alive (win32 especially).
                killChildTree(child);
              }, timeoutMs)
            : null;

        // Run once on any terminal transition: drop the timer, detach the abort
        // listener, and clear the persisted child record (it has exited / been killed).
        const cleanup = (): void => {
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (correlationId && nodeId) caps.run.clearChild(correlationId, nodeId);
        };

        // Cap capture so a chatty long job can't exhaust memory; the tail of the
        // log (where results usually print) survives within the cap. The live
        // sink gets every chunk regardless (it tail-caps independently).
        child.stdout?.on("data", (d: Buffer) => { const t = d.toString(); if (stdout.length < maxOut) stdout += t; sink(t); });
        child.stderr?.on("data", (d: Buffer) => { const t = d.toString(); if (stderr.length < maxOut) stderr += t; sink(t); });
        child.on("error", (err) => {
          cleanup();
          // Async spawn failure — log the offending length (BUG-006) and reject with
          // a greppable message (BUG-009).
          caps.log("error", "exec_spawn_failed", { phase: "async", error: err.message, length: command.length, correlationId, nodeId });
          reject(new Error(`core:exec: failed to spawn command — ${err.message} (command length ${command.length})${where}`));
        });
        child.on("close", (code) => {
          cleanup();
          if (timedOut) {
            reject(new Error(`core:exec: command exceeded timeoutMs=${timeoutMs} and was killed${where}`));
            return;
          }

          // Apply secrets redaction before surfacing output.
          // scrub:false opt-out is for the rare case where the output IS the secret
          // (e.g. key-generation tools) and the caller owns handling.
          const out = scrubOut(stdout.trim(), stderr.trim(), doScrub);

          // Cancelled: a definite RESULT (ok:false, cancelled:true), never a hang. The
          // runner marks the run "cancelled" and suppresses the downstream notify; we
          // still surface whatever output was captured before the kill.
          if (cancelled) {
            resolve({ ok: false, cancelled: true, exitCode: code ?? -1, stdout: out.stdout, stderr: out.stderr, ...(out.scrubbed ? { scrubbed: out.scrubbed } : {}) });
            return;
          }
          resolve({ ok: code === 0, exitCode: code ?? -1, stdout: out.stdout, stderr: out.stderr, ...(out.scrubbed ? { scrubbed: out.scrubbed } : {}) });
        });
        });
      }

      return await spawnFresh();
    },
  }),
];

/**
 * Pull the file a shell command redirects its OWN stdout to, so core:exec can tail
 * it live without the author repeating the path in a `logFile` param. Returns the
 * LAST stdout-bound redirect target — `>`, `>>`, `1>`, `1>>`, `&>`, `&>>` (truncate
 * or append), the effective destination — or null when stdout isn't redirected to a
 * file.
 *
 * This parses an arbitrary command string — a boundary, so it stays defensive and
 * returns null rather than asserting. It is deliberately narrow:
 *   - a fd-dup (`2>&1`, `>&2`) is NOT a file: the `&`-target is excluded, so it's skipped;
 *   - a bare `2>` (stderr) is ignored — stdout still flows to the pipe we already stream;
 *   - a `>` inside quotes (e.g. `echo "a > b"`) can false-positive to a path that won't
 *     exist; the tail then reads empty (the honest no-output state), never garbage.
 */
export function detectStdoutRedirect(command: string): string | null {
  // (?:^|\s)   the operator starts at a boundary, so the `2` in `2>` (no space before
  //            the `>`) can't be read as a stdout redirect.
  // (?:1|&)?   optional fd — stdout (1) or both (&); a leading `2` is not in the set.
  // >>?        `>` or `>>` (truncate or append — both are tail targets).
  // target     a quoted path, or a run of non-space/redirect/separator chars; `&N`
  //            fd-dups are excluded by the `&` in the negated class.
  const redirect = /(?:^|\s)(?:1|&)?>>?\s*("[^"]*"|'[^']*'|[^\s>&|;]+)/g;
  let match: RegExpExecArray | null;
  let target: string | null = null;
  while ((match = redirect.exec(command)) !== null) {
    const raw = match[1];
    target = raw[0] === '"' || raw[0] === "'" ? raw.slice(1, -1) : raw;
  }
  return target;
}
