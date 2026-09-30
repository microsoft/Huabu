# Alpha Canary Deployment

> Personal-development deployment workflow for the long-lived `alpha` branch. This is not the stable release or promotion path.

## Branch and authorization model

`main` is the stable branch. `alpha` is the rolling integration branch used by the personal Canary. Issue branches start from `origin/alpha` and target `alpha`; promotion from `alpha` to `main` remains a separate reviewed action.

Canary use is additional end-to-end evidence only. It does not replace pull-request CI, review, documentation, release validation, or authorization to promote or publish.

## Supported workflow

The supported helper runs from a source checkout through `pnpm start:web`. `scripts/start-web.mjs` captures the startup commit in `HUABU_DEPLOYED_SHA` and exports the resolved checkout root as `HUABU_REPO_ROOT` before loading the bundled Server.

Setting `HUABU_CANARY_REDEPLOY_ENABLED=1` enables an owner-only Settings surface. Opening Settings compares the captured startup commit with the current `origin/alpha` SHA using the fixed command `git ls-remote origin refs/heads/alpha`. The result identifies a different branch head; it does not independently attest CI status.

The owner may confirm `Redeploy Alpha`. The HTTP request carries an empty body and cannot select a command, path, branch, SHA, or arguments. The Server launches a detached runner with the fixed executable and arguments:

```text
<repository>/scripts/start-huabu.sh alpha --non-interactive
```

The runner persists `requested`, `running`, `succeeded`, or `failed` state under `HUABU_DATA_DIR`, appends a local log, and survives the current Server process exiting. It waits briefly before invoking the script so the Server can flush HTTP 202; that response means only that the runner started. Success means the script exited zero after its bounded readiness probe.

## Script behavior

`scripts/start-huabu.sh` derives the repository root from its own tracked path, so the checkout may live anywhere. Direct operator use accepts a branch argument; the UI invocation is always fixed to `alpha`.

The script requires a clean checkout, stops listeners on ports 3001–3005, removes the previous `app` tmux session, checks out and fast-forwards the selected branch, installs locked dependencies, and starts `pnpm start:web` in a new `app` session. Interactive use tails `/tmp/huabu-app.log`; `--non-interactive` exits after readiness succeeds or times out.

The script intentionally preserves the existing personal-development tradeoff: it updates one checkout in place and stops the old service before pull, install, and build complete. A failed redeployment can leave the Canary offline, and the port-range stop can affect another process using those ports. There is no rollback, immutable release directory, service preservation, self-restart supervisor, systemd unit, container deployment, or automatic installation. Inspect the persisted runner status and log, then repair manually through SSH when needed.

## Security boundary

Status, check, and redeploy routes require the existing single-owner boundary: loopback access or successful HTTP Basic Auth. Possession of the RFS connection token does not authorize redeployment.

The feature is disabled by default and unavailable in packaged Desktop mode. The Server resolves one repository-owned script and supplies one fixed argument array without a shell. Browser input never reaches process spawning. Status responses are bounded and exclude environment values, credentials, repository paths, and raw command output.

Remote browser access continues to require the bind, allowed-host, Basic Auth, and operator-managed HTTPS or trusted-private-network controls in [deployment security](./deployment-security.md).

## Code entry points

| File                                                                                                                               | Responsibility                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`scripts/start-huabu.sh`](../../scripts/start-huabu.sh)                                                                           | Path-independent tmux redeployment and readiness probe.                               |
| [`scripts/canary-redeploy-runner.mjs`](../../scripts/canary-redeploy-runner.mjs)                                                   | Detached execution, persistent result state, and local logging.                       |
| [`scripts/start-web.mjs`](../../scripts/start-web.mjs)                                                                             | Captures repository root and deployed SHA for the standalone Server.                  |
| [`packages/shared/src/types/api/deployment.ts`](../../packages/shared/src/types/api/deployment.ts)                                 | Canary status and action wire contracts.                                              |
| [`apps/server/src/modules/security/canary-redeploy.ts`](../../apps/server/src/modules/security/canary-redeploy.ts)                 | Capability resolution, remote SHA check, status persistence, and fixed runner launch. |
| [`apps/server/src/modules/security/canary-redeploy.route.ts`](../../apps/server/src/modules/security/canary-redeploy.route.ts)     | Owner-only status, check, and redeploy endpoints.                                     |
| [`apps/web/src/components/Settings/CanaryRedeploySettings.tsx`](../../apps/web/src/components/Settings/CanaryRedeploySettings.tsx) | Settings status, check action, and confirmed redeploy action.                         |
