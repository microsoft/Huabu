# Deployment Security

> Network exposure, owner authentication, deployment readiness, and transport guidance. Last updated: 2026-08-15

## Security model

Huabu is a single-owner application. It distinguishes the authenticated owner from unauthenticated callers and does not define viewer, administrator, or multi-user roles.

The owner may perform Settings, OAuth, credential, External Agent, and Agent Team operations when either condition holds:

- the request's direct TCP peer is loopback;
- the request passed Huabu's configured HTTP Basic Auth gate.

The connection token is a separate machine credential used by RFS and the embedded Agentlet transport. Its generation and injection are independent of browser owner authentication.

## Bind and authentication policy

`HUABU_BIND_HOST` defaults to `127.0.0.1`. A non-loopback bind requires all of `HUABU_ALLOWED_HOSTS`, `HUABU_BASIC_AUTH_USER`, and `HUABU_BASIC_AUTH_PASS`; the server fails before listening when any requirement is missing. A partial Basic Auth pair also fails on loopback because silently disabling authentication is more dangerous than rejecting an invalid deployment.

`HUABU_ALLOWED_HOSTS` contains only hostnames or IP addresses, without scheme, port, or path. Loopback aliases remain built in. The same resolved set drives the Host guard, CORS, and the Origin fallback.

`pnpm dev` keeps zero-configuration access for loopback clients. Vite listens on all interfaces for development flexibility, but a non-loopback client must pass complete Basic Auth before receiving assets or reaching the API proxy. The Authorization header reaches Fastify, so owner authorization does not depend on Vite's loopback backend connection.

`pnpm start:web` serves the compiled SPA and API from Fastify. On a non-loopback bind, startup validation guarantees that every browser route is behind Basic Auth.

## Deployment readiness

`GET /api/deployment/readiness` is available before workspace activation. It returns the resolved bind scope, whether remote-access prerequisites are configured, whether the current request is recognized as the owner, credential-store writability, transport status, and structured warning codes.

The response is deliberately redacted: it never contains usernames, passwords, connection tokens, secret keys, credential values, or the configured allowed-host entries.

Settings loads readiness when it opens. A read-only credential store disables API-key and OAuth mutations while leaving non-secret model configuration available. Standalone deployments enable encrypted credential writes with `HUABU_SECRET_KEY`; see [`credential-storage.md`](./credential-storage.md).

## Transport

Huabu's Node server currently speaks HTTP. A non-loopback bind logs and reports `operator-unverified` transport because the process cannot prove whether a private network or external TLS terminator protects the client-facing connection.

Production HTTPS termination belongs to deployment infrastructure such as Caddy, Nginx, Tailscale Serve, or a cloud load balancer. Trusted-proxy identity and verified forwarded transport are intentionally separate from the current direct/Vite deployment boundary and must not be implemented by accepting arbitrary forwarding headers.

## Code entry points

| File                                                                                                                                     | Responsibility                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`apps/server/src/modules/security/deployment-config.ts`](../../apps/server/src/modules/security/deployment-config.ts)                   | Resolve and fail closed on invalid bind, allowed-host, and Basic Auth combinations. |
| [`apps/server/src/modules/security/owner.ts`](../../apps/server/src/modules/security/owner.ts)                                           | Recognize the loopback or Basic-authenticated single owner.                         |
| [`apps/server/src/modules/security/deployment.route.ts`](../../apps/server/src/modules/security/deployment.route.ts)                     | Serve the redacted readiness model.                                                 |
| [`apps/server/src/app.ts`](../../apps/server/src/app.ts)                                                                                 | Apply Host, Origin, Basic Auth, and route composition.                              |
| [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts)                                                                               | Gate non-loopback development clients before assets and API proxying.               |
| [`apps/web/src/components/Settings/DeploymentReadinessNotice.tsx`](../../apps/web/src/components/Settings/DeploymentReadinessNotice.tsx) | Explain readiness warnings in Settings.                                             |
