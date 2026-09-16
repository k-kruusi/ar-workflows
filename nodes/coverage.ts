/**
 * Coverage map nodes — init/mark/summary primitives for tracking which research
 * cells have been answered, are conflicted, or remain open.
 *
 * Storage: the existing node-ledger substrate (data/node-ledgers/coverage-*.jsonl).
 * No new deps, no new storage mechanism.
 */
import { defineNode, type NodeDef } from "./contract.js";
import {
  COVERAGE_STATUSES,
  coverageLedgerName,
  reduceCoverage,
  type CoverageStatus,
} from "./coverage-types.js";

function resolveRunKey(
  inputs: { has(k: string): boolean; str(k: string, o?: Record<string, unknown>): string },
  correlationId: string | undefined,
  type: string,
): string {
  if (inputs.has("runKey")) return inputs.str("runKey");
  if (correlationId) return correlationId;
  throw new Error(`${type}: input "runKey" is required (no correlationId available to default to)`);
}

function parseCells(raw: unknown): string[] {
  if (Array.isArray(raw) && raw.length > 0 && raw.every((v) => typeof v === "string")) {
    return raw as string[];
  }
  if (
    raw !== null &&
    raw !== undefined &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.keys(raw).length > 0
  ) {
    return Object.keys(raw);
  }
  throw new Error(
    `coverage:init: input "cells" must be a non-empty array of strings or an object of cell-id keys`,
  );
}

function parseStatus(raw: string): CoverageStatus {
  if ((COVERAGE_STATUSES as readonly string[]).includes(raw)) return raw as CoverageStatus;
  const matches = [
    ...raw.matchAll(/STATUS:\s*(missing|filled|uncertain|conflicted|unreachable)/gi),
  ];
  if (matches.length > 0) return matches[matches.length - 1][1].toLowerCase() as CoverageStatus;
  throw new Error(
    `coverage:mark: input "status" must be one of ${COVERAGE_STATUSES.join("|")} (got ${JSON.stringify(raw.slice(0, 80))})`,
  );
}

export const coverageNodes: NodeDef[] = [
  defineNode({
    type: "coverage:init",
    description:
      "Seeds a coverage ledger with one 'missing' row per cell id. Inputs: runKey (string, defaults to correlationId), cells (non-empty array of strings OR object whose keys are cell ids). Returns { initialized: n }.",
    run: async ({ inputs, caps, correlationId }) => {
      const runKey = resolveRunKey(inputs, correlationId, "coverage:init");
      const cells = parseCells(inputs.raw("cells"));
      const ledger = coverageLedgerName(runKey);
      for (const cell of cells) {
        caps.ledgerAppend(ledger, { runKey, cell, status: "missing" });
      }
      return { initialized: cells.length };
    },
  }),

  defineNode({
    type: "coverage:mark",
    description:
      "Appends a status mark for one cell (last-writer-wins on read). Accepts an exact status enum value OR extracts the LAST 'STATUS: <value>' line from prose (so explorer agents can end their reply with a status line). Inputs: runKey, cell, status, evidence? (obj), confidence? (0..1), by? (string). Returns { cell, status }.",
    run: async ({ inputs, caps, correlationId }) => {
      const runKey = resolveRunKey(inputs, correlationId, "coverage:mark");
      const cell = inputs.str("cell", { required: true });
      const status = parseStatus(inputs.str("status", { required: true }));
      const evidence = inputs.has("evidence")
        ? (inputs.obj("evidence") as Record<string, unknown>)
        : undefined;
      const confidence = inputs.has("confidence")
        ? inputs.num("confidence", { min: 0, max: 1 })
        : undefined;
      const by = inputs.has("by") ? inputs.str("by") : undefined;
      caps.ledgerAppend(coverageLedgerName(runKey), {
        runKey,
        cell,
        status,
        ...(evidence !== undefined && { evidence }),
        ...(confidence !== undefined && { confidence }),
        ...(by !== undefined && { by }),
      });
      return { cell, status };
    },
  }),

  defineNode({
    type: "coverage:summary",
    description:
      "Reduces a run's coverage ledger to a byStatus tally + gap list (last-writer-wins per cell, ordered by first appearance). Inputs: runKey. Returns { total, byStatus, cells, gaps }.",
    run: async ({ inputs, caps, correlationId }) => {
      const runKey = resolveRunKey(inputs, correlationId, "coverage:summary");
      const rows = caps.ledgerRead(coverageLedgerName(runKey));
      return reduceCoverage(rows) as unknown as Record<string, unknown>;
    },
  }),
];
