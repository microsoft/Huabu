# Deployment Security

> Network exposure, owner authentication, deployment readiness, transport guidance, and request-volume controls. Last updated: 2026-09-23

## Security model

Huabu is a single-owner application. A Huabu-owned `IdentityService` resolves the caller before routes execute. It distinguishes the authenticated owner from unauthenticated callers and does not define viewer, administrator, or multi-user roles. Conversations and agent execution remain Agenetes-owned.

The default `local` provider needs no directory or identity server. It supplies a stable synthetic `local-owner` principal. The owner may perform Settings, OAuth, credential, External Agent Profile and harness-discovery operations when either condition holds:

- Basic Auth is unconfigured and the credential-free request's direct TCP peer is loopback;
- the request passed Huabu's configured HTTP Basic Auth gate.

The connection token is a separate machine credential used by RFS and the embedded Agentlet transport. Its generation and injection are independent of browser owner authentication. It resolves to the `huabu-agentlet` bot, without owner authority even when its TCP peer is loopback. The existing machine reachback surface remains available in both identity modes; public credential-free root Skill bootstrap and CORS preflights remain exempt from authentication.

The global Agent Change Review configuration follows the same owner boundary. `GET` and `PUT /api/agent-change-review/config` are available only to requests resolved as owners by the selected identity provider; possession of the RFS connection token does not authorize reading or changing the automatic-acceptance policy.

Optional submission-time Ink OCR is an explicit outbound data boundary. Configuring an Azure AI Vision endpoint and key through Settings > General or `VISION_ENDPOINT` / `VISION_KEY` opts the Server into sending a transient raster containing only the selected Ink strokes to that resource when the owner submits an Ink Query. Settings sends newly entered keys to the owner-authorized Server for secure storage; reads never return a plaintext key, and the browser never calls Azure directly. Both reads and writes at `/api/integrations/ink-ocr/config` require owner authorization. Only Azure AI Vision's Image Analysis Read protocol is supported. Successful OCR evidence persists both in the structured envelope at `AgentSubmission.content.focus.selection.inkRecognition` and in the canonical inputs at `AgentSubmission.rendered`. Normal provider diagnostics record only outcome, duration, HTTP status, raster dimensions, node count, and line count; they exclude credentials, endpoint values, image bytes, and recognized text.

Prompt debugging is a separate local retention surface: when enabled, it writes the assembled prompt, including OCR evidence subject to the diagnostic's text truncation. When `HUABU_DEBUG_PROMPT` is unset, it defaults to enabled outside production and disabled in production; an explicit value overrides that default. Set `HUABU_DEBUG_PROMPT=off` to disable these additional prompt logs. This does not disable normal conversation persistence or remove previously written data. Operators are responsible for the persisted conversation, local debug artifacts, and the configured Azure resource's data-processing and retention policy.

OCR settings validate HTTPS resource-root endpoints against the Azure public-cloud `cognitiveservices.azure.com` and regional `api.cognitive.microsoft.com` host forms, excluding arbitrary gateways, IP literals, non-default ports, and sovereign-cloud endpoints. The adapter applies the same validation to effective stored/environment configuration before sending a key and rejects redirects. The endpoint and key overrides are persisted as one encrypted SecretStore record with serialized updates, avoiding the partial-write state where a replacement key could be sent to a previous endpoint. All settings mutations require writable secure storage; read-only deployments may still use environment configuration. See [credential storage](./credential-storage.md) for migration and fallback semantics.

## Bind and authentication policy

`HUABU_BIND_HOST` defaults to `127.0.0.1`. With local identity, a non-loopback bind requires all of `HUABU_ALLOWED_HOSTS`, `HUABU_BASIC_AUTH_USER`, and `HUABU_BASIC_AUTH_PASS`; the server fails before listening when any requirement is missing. A partial Basic Auth pair also fails on loopback because silently disabling authentication is more dangerous than rejecting an invalid deployment. Bubble identity replaces the Basic Auth requirement, while allowed hosts remain required.

`HUABU_ALLOWED_HOSTS` contains only hostnames or IP addresses, without scheme, port, or path. Loopback aliases remain built in. The same resolved set drives the Host guard, CORS, and the Origin fallback.

`pnpm dev` keeps zero-configuration access for loopback clients. Vite listens on all interfaces for development flexibility, but a non-loopback client must pass complete Basic Auth before receiving assets or reaching the API proxy. The Authorization header reaches Fastify, so owner authorization does not depend on Vite's loopback backend connection.

`pnpm start:web` serves the compiled SPA and API from Fastify. With local identity on a non-loopback bind, startup validation guarantees that every browser route is behind Basic Auth.

## Bubble identity: first integration

Set `HUABU_IDENTITY_PROVIDER=bubble` and `HUABU_BUBBLE_URL` to the Bubble base URL, including its mount prefix when present. Do not set the Basic Auth pair in this mode. The URL must use HTTPS, except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`, and cannot contain credentials, a query, or a fragment. A network bind still needs `HUABU_ALLOWED_HOSTS`.

The HTTP adapter forwards only the caller's Bearer authorization to `GET <base>/v1/auth/whoami`. Bubble owns credential validation, its durable principal directory, issuer/subject mapping, and account status. Huabu preserves the returned principal ID and projects only kind, display name, email, and avatar. No second directory, credential cache, or cross-provider account merge is created. Each request revalidates with Bubble; requests time out after five seconds, redirects are refused, and upstream failures return a redacted 503. Selecting Bubble never falls back to local identity, including for loopback requests.

This stage keeps Huabu's shared Workspace private by requiring a Bubble `owner` grant on the `system` target for ordinary application access. A thread or principal owner grant does not qualify. An authenticated non-owner can inspect only `GET /api/identity`. This is an explicit initial Huabu admission policy, not Workspace/Space authorization and not a replacement for future per-resource permissions. Configure Bubble with `autoGrantFirstUserSystemOwner: false` and provision administrators explicitly before serving Huabu users.

`GET /api/identity` works before Workspace activation and returns `{ provider, principal, owner }` with `Cache-Control: no-store`. No token, external subject, issuer, or grant list is returned. Readiness reports `owner.policy: "bubble-system-owner"` in Bubble mode and retains `"loopback-or-basic-auth"` in local mode. Owner-only routes consume the resolved request identity; a loopback address does not override Bubble denial.

Long-lived Bubble-authenticated HTTP responses, including existing SSE streams, revalidate every 30 seconds. Revocation, lost owner authority, changed principal, or provider failure closes the response. Stream revalidation is released when the response ends, and outstanding responses are closed during server shutdown. This does not cancel an already-running agent job.

This identity-only integration connects to an existing Bubble server; it does not yet embed Bubble, share its database, or mount its conversation routes. This work builds on the Node 24 prerequisite in PR #236; local deployments install no Bubble runtime. An embedded adapter can later implement the same `IdentityService` contract. Use a Bubble deployment containing the September 23 identity/revocation changes (umbrella `48b7d727` or a later release).

Browser login/session handling is a subsequent phase. For now, Bubble mode is usable by clients supplying an existing Bubble Bearer token; Huabu's SPA and Desktop Basic Auth prompt do not acquire or refresh it. Vite's remote Basic Auth gate remains local-mode tooling. Use the built server API for this first integration. Example with a token already held in the caller's environment:

```sh
curl -H "Authorization: Bearer $BUBBLE_TOKEN" https://huabu.example/api/identity
```

Changing providers does not migrate or link `local-owner` to a Bubble principal. Existing conversation records remain untouched.

`pnpm start:desktop --server <URL>` is a native client for the same remote deployment boundary. It accepts a root HTTP or HTTPS origin but does not weaken the Server's Host, Origin, CORS, or Basic Auth policy and does not inject allowed hosts. A `401` challenge from the selected exact origin opens a sandboxed Electron credential prompt; credentials remain in Chromium's current network session and are not placed in the command line, exposed to the renderer, or persisted by Huabu Desktop.

## Deployment readiness

`GET /api/deployment/readiness` is available before workspace activation. It returns the resolved bind scope, whether remote-access prerequisites are configured, whether the current request is recognized as the owner, credential-store writability, transport status, and structured warning codes.

The response is deliberately redacted: it never contains usernames, passwords, connection tokens, secret keys, credential values, or the configured allowed-host entries.

Settings loads readiness when it opens. A read-only credential store disables API-key and OAuth mutations while leaving non-secret model configuration available. Standalone deployments enable encrypted credential writes with `HUABU_SECRET_KEY`; see [`credential-storage.md`](./credential-storage.md).

## Application-wide rate limiting

Every production HTTP route inherits one in-memory `@fastify/rate-limit` policy: 1,000 admitted requests per 60-second window, keyed by the normalized direct TCP peer IP. Authentication and authorization are independent of admission control, so loopback clients, Basic-authenticated browser traffic, and RFS bearer traffic receive neither a bypass nor credential-specific buckets.

Huabu does not enable Fastify `trustProxy` and does not derive rate-limit identity from `Forwarded`, `X-Forwarded-For`, or similar caller-controlled headers. A supported external TLS terminator therefore shares one bucket for all clients that reach Huabu through that proxy. Per-client identity behind trusted proxies requires a future explicit proxy trust contract; operators must not enable arbitrary forwarded-header trust as a workaround.

`OPTIONS` preflights and `GET /api/deployment/readiness` are exempt so browsers can negotiate access and deployment monitoring remains available. There is no separate health endpoint. Static assets, ordinary APIs, RFS—including the public root Skill bootstrap—and uploads are limited. Upload admission runs before body parsing and remains additionally bounded by the 500 MB upload-size ceiling.

An SSE connection attempt consumes one request when the stream opens; events and heartbeats on the established connection consume no further requests. Reconnect attempts are ordinary requests. A rejected request returns HTTP 429 with the canonical `ApiErrorBody`, `code: "RATE_LIMITED"`, retry details, limit/remaining/reset headers, and `Retry-After`. The web client shows one deduplicated warning and Canvas Sync waits at least the advertised retry interval before reconnecting. The server records a structured warning containing the direct-peer key, method, and route template, never credentials.

## Transport

Huabu's Node server currently speaks HTTP. A non-loopback bind logs and reports `operator-unverified` transport because the process cannot prove whether a private network or external TLS terminator protects the client-facing connection.

Production HTTPS termination belongs to deployment infrastructure such as Caddy, Nginx, Tailscale Serve, or a cloud load balancer. Trusted-proxy identity and verified forwarded transport are intentionally separate from the current direct/Vite deployment boundary and must not be implemented by accepting arbitrary forwarding headers.

The Desktop remote-client path uses the operating system's normal certificate validation and does not bypass invalid or self-signed certificate errors. Its startup readiness probe follows no redirects, so an unexpected redirect, TLS failure, unreachable host, rejected Host header, or incompatible readiness response produces an actionable startup failure instead of silently starting a local Server.

## Code entry points

| File                                                                                                                                     | Responsibility                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`apps/server/src/modules/security/deployment-config.ts`](../../apps/server/src/modules/security/deployment-config.ts)                   | Resolve and fail closed on invalid bind, allowed-host, and Basic Auth combinations.  |
| [`apps/server/src/modules/security/owner.ts`](../../apps/server/src/modules/security/owner.ts)                                           | Recognize the loopback or Basic-authenticated single owner.                          |
| [`apps/server/src/modules/security/deployment.route.ts`](../../apps/server/src/modules/security/deployment.route.ts)                     | Serve the redacted readiness model.                                                  |
| [`apps/server/src/modules/security/rate-limit.ts`](../../apps/server/src/modules/security/rate-limit.ts)                                 | Define global request admission, identity, exemptions, and 429 diagnostics.          |
| [`apps/server/src/modules/agent/change-review-config.route.ts`](../../apps/server/src/modules/agent/change-review-config.route.ts)       | Enforce owner-only access to the global Agent Change Review configuration.           |
| [`apps/server/src/modules/agent/conversation/ink-ocr.ts`](../../apps/server/src/modules/agent/conversation/ink-ocr.ts)                   | Enforce the bounded, server-only Azure Vision OCR boundary and redacted diagnostics. |
| [`apps/server/src/app.ts`](../../apps/server/src/app.ts)                                                                                 | Apply Host, Origin, Basic Auth, and route composition.                               |
| [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts)                                                                               | Gate non-loopback development clients before assets and API proxying.                |
| [`apps/web/src/components/Settings/DeploymentReadinessNotice.tsx`](../../apps/web/src/components/Settings/DeploymentReadinessNotice.tsx) | Explain readiness warnings in Settings.                                              |
| [`apps/desktop/src/server-target.ts`](../../apps/desktop/src/server-target.ts)                                                           | Validate a remote origin and probe the deployment-readiness contract.                |
| [`apps/desktop/src/remote-basic-auth.ts`](../../apps/desktop/src/remote-basic-auth.ts)                                                   | Restrict HTTP Basic Auth challenges to the configured exact origin.                  |
