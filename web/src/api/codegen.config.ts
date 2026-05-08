/**
 * Codegen configuration for the API types.
 *
 * `openapi-typescript`'s CLI is sufficient for our needs — it accepts an
 * input path / URL + an output file via flags, with no per-project
 * customization needed. We don't transform the spec, don't rename
 * schemas, and don't need a JS-config bridge.
 *
 * The flow lives in `web/scripts/regenerate-api-types.sh`:
 *
 * 1. Boot a temp substrate with a tmp token + workspace.
 * 2. Wait for `/openapi.json`.
 * 3. `pnpm exec openapi-typescript /tmp/andes-openapi.json -o
 *    src/api/generated.ts`.
 * 4. Tear the substrate down.
 *
 * If we ever need transforms (renaming schemas, adding `readOnly` overrides,
 * patching the spec for a known-broken FastAPI quirk), this file becomes
 * the place that documents *why* — keep that escape hatch close to where
 * the pipeline lives.
 *
 * Re-exporting an empty config object here so callers that want a
 * runtime-readable knob (e.g., a future build step that branches on a
 * project setting) have a stable import target.
 */

export interface CodegenConfig {
  /** Output path for the generated types file, relative to `web/`. */
  output: string;
  /**
   * URL or path to the input OpenAPI spec at codegen time. This value
   * lives in the shell script, not here — but we keep its shape
   * documented so a future TS-driven runner stays aligned.
   */
  input?: string;
}

export const codegenConfig: CodegenConfig = {
  output: 'src/api/generated.ts',
} as const;
