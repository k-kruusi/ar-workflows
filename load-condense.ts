/** Runtime loader for quarantine condense — URL import survives tsx + moved dist roots. */
export async function loadCondenseContent() {
  const { condenseContent } = await import(
    new URL("../../packages/quarantine/src/lib/condense.js", import.meta.url).href
  );
  return condenseContent as (
    input: string,
    task?: string,
    opts?: { engine?: "llm" | "test" },
  ) => Promise<
    | { ok: true; text: string; originalBytes: number; condensedBytes: number }
    | { ok: false; error: string }
  >;
}