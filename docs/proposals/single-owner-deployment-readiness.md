# Single-owner deployment readiness

Status: Shipped

Last updated: 2026-08-15

## Context

Huabu is a single-owner application. Its network boundary distinguishes the authenticated owner from unauthenticated callers; it does not define separate viewer and administrator roles.

The production-style `pnpm start:web` path exposes Fastify directly, so loopback-only Settings and OAuth routes reject an authenticated owner connecting remotely. The `pnpm dev` path has the opposite failure: Vite listens on all interfaces and proxies `/api` to Fastify over loopback, so Fastify cannot distinguish a remote browser from a local caller. Missing `HUABU_SECRET_KEY` is also discovered only after a credential write fails.

## Decision

The existing Basic Auth identity is the sole remote owner identity. A request may perform owner operations when it either arrives directly from loopback or has passed Huabu's Basic Auth gate. No Admin Token, role system, login page, cookie session, or remote-administration feature flag is introduced.

The existing connection token remains unchanged and outside this proposal. It continues to authenticate RFS and Agentlet connections and is not a browser login credential.

## Startup policy

The default bind remains `127.0.0.1`. A non-loopback bind fails startup unless `HUABU_ALLOWED_HOSTS`, `HUABU_BASIC_AUTH_USER`, and `HUABU_BASIC_AUTH_PASS` are all configured. A partial Basic Auth pair always fails startup. Remote HTTP remains available for compatibility with today's development security baseline, but startup and readiness report transport security as operator-unverified and recommend HTTPS or a trusted private network.

Vite keeps zero-configuration loopback development. A non-loopback browser reaching Vite must pass complete Basic Auth before it can receive static assets or reach the API proxy. Vite forwards the Authorization header, allowing Fastify to recognize the same owner identity instead of relying on the proxy's loopback TCP address.

## Readiness model

`GET /api/deployment/readiness` is available before workspace activation and returns only redacted capabilities:

- resolved bind host and loopback scope;
- whether allowed hosts and Basic Auth are configured;
- whether the current request is authorized as the owner;
- whether credential persistence is writable and an actionable reason when it is not;
- transport status and structured warning codes.

The response never includes usernames, passwords, connection tokens, secret keys, credentials, or allowed-host values.

## UI behavior

Settings loads readiness with its other initial state. Read-only credential storage is explained before an attempted write. API-key persistence and OAuth actions are disabled while non-secret model configuration remains available. An operator-unverified transport warning is informational and does not block the current HTTP-compatible workflow.

## Security invariants

- The default bind remains loopback.
- Host, CORS, Origin, Fetch Metadata, Basic Auth, and RFS bearer checks remain active.
- Remote Vite access cannot bypass Basic Auth because the final Fastify hop is loopback.
- Basic Auth configuration fails closed when incomplete.
- Connection-token behavior is unchanged.
- Readiness is descriptive and never substitutes for server-side authorization.

## Validation

Regression coverage must include local Electron and development behavior, remote Vite with and without Basic Auth, direct `start:web` configuration validation, authenticated remote owner operations, credential-store writability, and readiness redaction.
