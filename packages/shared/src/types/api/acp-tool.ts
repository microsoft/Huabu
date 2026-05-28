/**
 * ACP rich-update zod schemas (re-exported from `@agentclientprotocol/sdk`).
 *
 * Runtime validators that mirror the type re-exports in
 * `../agent/acp-tool.ts`. Server code (`acp/translator.ts`,
 * `acp/client.ts`) imports these to `safeParse` every payload that
 * arrives from an external agent — the agent process is OUTSIDE our
 * trust boundary, so each wire shape is validated before it becomes
 * an `AgentStreamEvent` or hits storage.
 *
 * ### Why a deep import path?
 *
 * The SDK's main entry (`@agentclientprotocol/sdk`) re-exports types
 * via `export type * from './schema/types.gen.js'`, but the runtime
 * zod schemas live in a separate barrel (`./schema/zod.gen.js`) that
 * the SDK does NOT re-export from main. The package also has no
 * `exports` field, so deep-import is the documented escape hatch.
 *
 * ### Web bundle hygiene
 *
 * This file imports zod **runtime**. It is re-exported from
 * `types/api/index.ts` (per existing convention for wire schemas),
 * which means the web bundle’s tree-shaker only drops it if every
 * web import of `@sediment/shared` is a `import type` (see
 * `.github/copilot-instructions.md` → API Endpoints). A vitest test
 * (`__tests__/acp-tool-bundle.test.ts`) asserts that none of the
 * `ZAcp*` symbols become reachable values when the web entry is
 * imported.
 *
 * ### Naming convention
 *
 * Sediment-wide convention is `ZAcp<TypeName>` (capital Z prefix,
 * camel-case body). This matches the existing
 * `wireNodeRefSchema` / `selectionNodeSchema` pattern only loosely;
 * we opt for the Z-prefix because the SDK already ships its own
 * `zAcp*` mixed-case names and round-tripping helps readability
 * (`type AcpToolCall = z.infer<typeof ZAcpToolCall>`).
 */

export {
  // Tool-call lifecycle
  zToolCall as ZAcpToolCall,
  zToolCallUpdate as ZAcpToolCallUpdate,
  zToolCallContent as ZAcpToolCallContent,
  zToolKind as ZAcpToolKind,
  zToolCallStatus as ZAcpToolCallStatus,
  zToolCallLocation as ZAcpToolCallLocation,
  // Generic content block (text/image/audio/resource/resource_link).
  zContentBlock as ZAcpContentBlock,
  // Plan updates
  zPlan as ZAcpPlan,
  zPlanEntry as ZAcpPlanEntry,
  // Session-update discriminated union — entry point for the translator.
  zSessionUpdate as ZAcpSessionUpdate,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';
