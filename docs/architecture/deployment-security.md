# Deployment Security

> Network exposure, owner authentication, deployment readiness, transport guidance, and request-volume controls. Last updated: 2026-09-18

## Security model

Huabu is a single-owner application. It distinguishes the authenticated owner from unauthenticated callers and does not define viewer, administrator, or multi-user roles.

The owner may perform Settings, OAuth, credential, External Agent, and Agent Team operations when either condition holds:

- the request's direct TCP peer is loopback;
- the request passed Huabu's configured HTTP Basic Auth gate.

The connection token is a separate machine credential used by RFS and the embedded Agentlet transport. Its generation and injection are independent of browser owner authentication.

The global Agent Change Review configuration follows the same owner boundary. `GET` and `PUT /api/agent-change-review/config` are available only to loopback or Basic-authenticated owner requests; possession of the RFS connection token does not authorize reading or changing the automatic-acceptance policy.

## Bind and authentication policy

`HUABU_BIND_HOST` defaults to `127.0.0.1`. A non-loopback bind requires all of `HUABU_ALLOWED_HOSTS`, `HUABU_BASIC_AUTH_USER`, and `HUABU_BASIC_AUTH_PASS`; the server fails before listening when any requirement is missing. A partial Basic Auth pair also fails on loopback because silently disabling authentication is more dangerous than rejecting an invalid deployment.

`HUABU_ALLOWED_HOSTS` contains only hostnames or IP addresses, without scheme, port, or path. Loopback aliases remain built in. The same resolved set drives the Host guard, CORS, and the Origin fallback.

`pnpm dev` keeps zero-configuration access for loopback clients. Vite listens on all interfaces for development flexibility, but a non-loopback client must pass complete Basic Auth before receiving assets or reaching the API proxy. The Authorization header reaches Fastify, so owner authorization does not depend on Vite's loopback backend connection.

`pnpm start:web` serves the compiled SPA and API from Fastify. On a non-loopback bind, startup validation guarantees that every browser route is behind Basic Auth.

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

| File                                                                                                                                     | Responsibility                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`apps/server/src/modules/security/deployment-config.ts`](../../apps/server/src/modules/security/deployment-config.ts)                   | Resolve and fail closed on invalid bind, allowed-host, and Basic Auth combinations. |
| [`apps/server/src/modules/security/owner.ts`](../../apps/server/src/modules/security/owner.ts)                                           | Recognize the loopback or Basic-authenticated single owner.                         |
| [`apps/server/src/modules/security/deployment.route.ts`](../../apps/server/src/modules/security/deployment.route.ts)                     | Serve the redacted readiness model.                                                 |
| [`apps/server/src/modules/security/rate-limit.ts`](../../apps/server/src/modules/security/rate-limit.ts)                                 | Define global request admission, identity, exemptions, and 429 diagnostics.         |
| [`apps/server/src/modules/agent/change-review-config.route.ts`](../../apps/server/src/modules/agent/change-review-config.route.ts)       | Enforce owner-only access to the global Agent Change Review configuration.          |
| [`apps/server/src/app.ts`](../../apps/server/src/app.ts)                                                                                 | Apply Host, Origin, Basic Auth, and route composition.                              |
| [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts)                                                                               | Gate non-loopback development clients before assets and API proxying.               |
| [`apps/web/src/components/Settings/DeploymentReadinessNotice.tsx`](../../apps/web/src/components/Settings/DeploymentReadinessNotice.tsx) | Explain readiness warnings in Settings.                                             |
| [`apps/desktop/src/server-target.ts`](../../apps/desktop/src/server-target.ts)                                                           | Validate a remote origin and probe the deployment-readiness contract.               |
| [`apps/desktop/src/remote-basic-auth.ts`](../../apps/desktop/src/remote-basic-auth.ts)                                                   | Restrict HTTP Basic Auth challenges to the configured exact origin.                 |
