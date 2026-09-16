/**
 * Coverage map types and the shared reducer.
 *
 * Pure module — no imports from caps.ts, contract.ts, or fs. Safe to import from
 * runner.ts without pulling in the node-definition layer.
 */

export type CoverageStatus = "missing" | "filled" | "uncertain" | "conflicted" | "unreachable";

export const COVERAGE_STATUSES: readonly CoverageStatus[] = [
  "missing",
  "filled",
  "uncertain",
  "conflicted",
  "unreachable",
] as const;

export interface CoverageCell {
  cell: string;
  status: CoverageStatus;
  evidence?: Record<string, unknown>;
  confidence?: number;
  by?: string;
  at: number;
}

export interface CoverageSummary {
  total: number;
  byStatus: Record<CoverageStatus, number>;
  cells: CoverageCell[];
  gaps: CoverageCell[];
}

export function coverageLedgerName(runKey: string): string {
  return `coverage-${runKey}`;
}

/**
 * Reduce a flat ledger row list to per-cell last-writer-wins state.
 *
 * Rows must be passed oldest-first (ledgerRead contract). Map.set on an existing
 * key overwrites the value but preserves the key's insertion-order position per
 * ECMA-262, so `cells` is ordered by first appearance regardless of re-marks.
 *
 * `at` comes from the ledger row's auto-stamped `ts` field (caps.ts ledgerAppend).
 */
export function reduceCoverage(rows: Array<Record<string, unknown>>): CoverageSummary {
  const byCell = new Map<string, CoverageCell>();

  for (const row of rows) {
    const cell = String(row.cell ?? "");
    if (!cell) continue;
    const status = row.status as CoverageStatus;
    byCell.set(cell, {
      cell,
      status,
      evidence: row.evidence as Record<string, unknown> | undefined,
      confidence: row.confidence as number | undefined,
      by: row.by as string | undefined,
      at: row.ts as number,
    });
  }

  const cells = [...byCell.values()];
  const byStatus = Object.fromEntries(
    COVERAGE_STATUSES.map((s) => [s, 0]),
  ) as Record<CoverageStatus, number>;
  for (const c of cells) byStatus[c.status]++;

  const gaps = cells.filter(
    (c) => c.status === "missing" || c.status === "conflicted" || c.status === "unreachable",
  );

  return { total: cells.length, byStatus, cells, gaps };
}
