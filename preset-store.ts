import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.js";

/**
 * A saved, named, pre-filled instance of a blueprint. The REFERENCE model: a
 * preset stores only the blueprint id + the param values, never a copy of the
 * graph — so editing the blueprint flows through to every preset, and a preset
 * is cheap. Running a preset is just `startNamed(blueprintId, params)`.
 */
export interface WorkflowPreset {
  id: string;          // generated, ts+random — stable handle for run/delete
  name: string;        // human label, e.g. "Resume spinor-dual xlarge → dr-claude"
  blueprintId: string; // the definition this preset fills, e.g. "exec-notify"
  params: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** Mint a preset id in the same shape the runner uses for correlation ids. */
export function makePresetId(): string {
  return `pre-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Durable store of workflow presets. One JSON file per preset under
 * `<dataDir>/workflow-presets/`. Write-through on every mutation (presets are
 * tiny + saved rarely, so the simplicity is worth it). Loaded on construction so
 * presets survive a supervisor restart. Machine-local + gitignored — presets are
 * operational state, not shared repo artifacts.
 */
export class WorkflowPresetStore {
  private presets = new Map<string, WorkflowPreset>();
  private readonly dir: string;

  constructor(dataDir: string) {
    // Same dataDir contract as WorkflowRunStore: ContainerManager.getDataDir(),
    // falling back to <cwd>/data only if empty at construction. data/ is gitignored.
    const base = dataDir || resolve(process.cwd(), "data");
    this.dir = resolve(base, "workflow-presets");
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.dir)) return;
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = readFileSync(resolve(this.dir, file), "utf-8");
          const preset = JSON.parse(raw) as WorkflowPreset;
          if (preset && typeof preset.id === "string") this.presets.set(preset.id, preset);
        } catch (err) {
          log("warn", "workflow_preset_load_failed", { file, error: String(err) });
        }
      }
      log("info", "workflow_presets_loaded", { count: this.presets.size });
    } catch (err) {
      log("warn", "workflow_preset_store_load_failed", { error: String(err) });
    }
  }

  private persist(preset: WorkflowPreset): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(resolve(this.dir, `${preset.id}.json`), JSON.stringify(preset), "utf-8");
    } catch (err) {
      log("warn", "workflow_preset_persist_failed", { id: preset.id, error: String(err) });
    }
  }

  /** Create a new preset, or update an existing one when `id` is supplied and known. */
  save(input: { id?: string; name: string; blueprintId: string; params: Record<string, unknown> }): WorkflowPreset {
    const now = Date.now();
    const existing = input.id ? this.presets.get(input.id) : undefined;
    const preset: WorkflowPreset = existing
      ? { ...existing, name: input.name, blueprintId: input.blueprintId, params: input.params, updatedAt: now }
      : { id: makePresetId(), name: input.name, blueprintId: input.blueprintId, params: input.params, createdAt: now, updatedAt: now };
    this.presets.set(preset.id, preset);
    this.persist(preset);
    return preset;
  }

  get(id: string): WorkflowPreset | undefined {
    return this.presets.get(id);
  }

  /** All presets, most-recently-updated first. */
  list(): WorkflowPreset[] {
    return [...this.presets.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Remove a preset (in-memory entry + persisted file). Returns whether it existed. */
  delete(id: string): boolean {
    const existed = this.presets.delete(id);
    // Map membership is the allowlist: the id arrives raw from the HTTP route and
    // is interpolated into the unlink path. Unlinking without this check would let
    // a traversal-shaped id ("../x") delete arbitrary *.json outside the store.
    // A persisted file only exists for ids that were in the map (load() is its inverse).
    if (existed) {
      try {
        const f = resolve(this.dir, `${id}.json`);
        if (existsSync(f)) unlinkSync(f);
      } catch (err) {
        log("warn", "workflow_preset_delete_failed", { id, error: String(err) });
      }
    }
    return existed;
  }
}
