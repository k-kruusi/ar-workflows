/**
 * Process-tree kill + command-line probe. A boundary module (it shells out to the
 * OS), so it stays defensive: every call is wrapped and failures are swallowed to a
 * best-effort no-op — a kill we can't perform is logged by the caller, never a throw
 * that takes the supervisor down.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * Kill a process AND its whole descendant tree by pid.
 *   - win32: `taskkill /PID <pid> /T /F` — /T includes the tree, /F forces. This is
 *     the ONLY reliable tree kill on Windows: a `child.kill()` reaches just the
 *     `cmd.exe` wrapper, leaving the real job (e.g. a python GPU process) orphaned.
 *   - posix: the child is spawned `detached` (its own process group leader), so a
 *     negative-pid signal reaches the whole group. Fall back to the bare pid if the
 *     group signal fails (child wasn't a leader / already gone).
 *
 * No-op on a missing/invalid pid. Fire-and-forget: we don't await the kill — the
 * caller observes the child's own `close` event once the OS reaps it.
 */
export function killTreeByPid(pid: number | undefined): void {
  if (!pid || pid <= 0 || !Number.isInteger(pid)) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // taskkill absent/failed — nothing else we can do from here; the caller logs.
    }
    return;
  }
  // posix: kill the process GROUP first (works only when the child leads its own
  // group — core:exec spawns detached on posix precisely so this is a full tree
  // kill), then the bare pid as a fallback. Both guarded: a stale pid throws ESRCH.
  try { process.kill(-pid, "SIGKILL"); } catch { /* no such group / already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** Kill a spawned child's whole tree. Prefers the pid path (real tree kill); falls
 *  back to node's own kill only if the pid is somehow absent. */
export function killChildTree(child: ChildProcess): void {
  if (child.pid) { killTreeByPid(child.pid); return; }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

/**
 * The live command line of a pid, or "" if the process is gone / unknowable. Used to
 * make an orphan sweep PID-reuse-safe: a recorded pid may have been recycled by the
 * OS onto an unrelated process after a restart, so we NEVER kill on a bare pid — we
 * first confirm the live process still carries the recorded command signature.
 *
 * Synchronous by design: called only at startup over the handful of runs left
 * "running" by a crash, where a brief block is acceptable and the code is simpler and
 * more reliable than an async collect. Returns "" (not a throw) on any failure — the
 * caller treats an unknowable command line as "do not kill".
 */
export function getProcessCommandLine(pid: number | undefined): string {
  if (!pid || pid <= 0 || !Number.isInteger(pid)) return "";
  try {
    if (process.platform === "win32") {
      // Get-CimInstance is the supported successor to the deprecated `wmic`. The
      // pid is a validated integer (guarded above), so single-quoting the filter is
      // injection-safe. -NoProfile keeps it fast; -NonInteractive prevents any prompt.
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
        { encoding: "utf-8", timeout: 10_000, windowsHide: true },
      );
      return (r.stdout || "").trim();
    }
    const r = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf-8", timeout: 10_000 });
    return (r.stdout || "").trim();
  } catch {
    return "";
  }
}
