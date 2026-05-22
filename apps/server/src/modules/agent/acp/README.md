# ACP (Agent Client Protocol) integration

External agent integration via [agentlet](https://github.com/hai-team/agentlet).
Sediment is the **ACP client**: the user runs `agentlet --agent "claude --acp"`
on their machine, the agentlet process opens a WebSocket back to this server,
and Sediment drives the ACP protocol over that connection.

## Status

- **Phase 0**: skeleton wired (this folder). `mountAgentletServer(app)` registered
  behind the `SEDIMENT_ENABLE_ACP=1` env flag, exposing `ws://<host>/api/acp/agent`.
  Auth is a placeholder that accepts any non-empty token. No client logic yet.
- **Phase 1+**: see [`docs/huabu-acp-client-plan.md`](../../../../../docs/huabu-acp-client-plan.md).

## Files

| File              | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `server-mount.ts` | Embed `@agentlet/server` into Fastify; expose `/acp/agent` WS upgrade |
| `index.ts`        | Public exports for the rest of the app                                |

## Local agentlet dependency

`@agentlet/server` and `@agentlet/protocol` are consumed via pnpm `link:`
pointing at `../../../../../agentlet/packages/*`. See
[docs/setup.md §7](../../../../../docs/setup.md) for the developer workflow.
