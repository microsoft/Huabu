# Alpha Canary Deployment

> Personal-development deployment workflow whose source branch defaults to `alpha`. This is not the stable release or promotion path.

## Branch and authorization model

`main` is the stable branch. `alpha` is the rolling integration branch and the compatibility-default source for the personal Canary. An owner may configure another branch, such as `x/alpha`, for one development deployment without changing the repository's issue-branch or promotion policy. Issue branches still start from `origin/alpha` and target `alpha`; promotion from `alpha` to `main` remains a separate reviewed action.

Canary use is additional end-to-end evidence only. It does not replace pull-request CI, review, documentation, release validation, or authorization to promote or publish.

## Supported workflow

The supported helper runs from a source checkout through `pnpm start:web`. `scripts/start-web.mjs` captures the startup commit in `HUABU_DEPLOYED_SHA` and exports the resolved checkout root as `HUABU_REPO_ROOT` before loading the bundled Server. Production-style startup binds the fixed `SERVER_PORT` (default `3001`) and fails rather than selecting another port when it is unavailable.

Setting `HUABU_CANARY_REDEPLOY_ENABLED=1` enables an owner-only Settings surface. The selected branch is persisted as an application-global versioned record under `HUABU_DATA_DIR`; a missing record or explicit cleared value resolves to `alpha`. Malformed stored configuration fails explicitly rather than silently using the default.

Opening Settings compares the captured startup commit with the exact configured remote ref using shell-free `git ls-remote --exit-code --refs origin refs/heads/<branch>`. Branch syntax is checked as a bounded full Git branch ref and option-like leading `-` values are rejected. A configured ref that is invalid or unavailable fails explicitly and never falls back to `alpha`. The result identifies a different branch head; it does not independently attest CI status.

The owner confirms the effective branch displayed by Settings. The request carries that branch only as a freshness guard; the Server rejects it if it no longer matches persisted configuration, so the request cannot independently select a deployment target. The Server launches a detached runner with the fixed executable and bounded arguments:

```text
<repository>/scripts/start-huabu.sh <effective-branch> --non-interactive
```

The runner persists the captured branch with `requested`, `running`, `succeeded`, or `failed` state under `HUABU_DATA_DIR`, appends a local log, and survives the current Server process exiting. It waits briefly before invoking the script so the Server can flush HTTP 202; that response means only that the runner started. Success means the script exited zero after its bounded readiness probe.

Only one check, configuration write, or redeployment admission may run at a time. A configuration write is rejected while a check or persisted runner is active, concurrent operations receive an explicit conflict, and an admitted redeployment cannot be retargeted. Persisted result status retains its captured branch so a later configuration can never make an older outcome appear to belong to another branch.

## Script behavior

`scripts/start-huabu.sh` derives the repository root from its own tracked path, so the checkout may live anywhere. Direct operator and Settings use both accept exactly one validated branch argument.

The script requires a clean checkout, resolves the fixed Server port from an exported `SERVER_PORT`, then the checkout's `.env`, then the default `3001`, and stops the listener on that port. It removes the previous `app` tmux session, fetches the exact `refs/heads/<branch>` from fixed remote `origin` into its matching remote-tracking ref, checks out or creates the matching local branch, and fast-forwards it without rewriting divergent work. It then installs locked dependencies and starts `pnpm start:web` in a new `app` session. Interactive use immediately tails `/tmp/huabu-app.log` while startup continues. `--non-interactive` instead waits for readiness on that same fixed port and exits when it succeeds or when the configurable `HUABU_CANARY_READINESS_TIMEOUT_SECONDS` window expires; the default is 300 seconds.

The script intentionally preserves the existing personal-development tradeoff: it updates one checkout in place and stops the old service before pull, install, and build complete. A failed redeployment can leave the Canary offline, and stopping the configured port can affect an unrelated process that owns it. There is no rollback, immutable release directory, service preservation, self-restart supervisor, systemd unit, container deployment, or automatic installation. Inspect the persisted runner status and log, then repair manually through SSH when needed.

## Security boundary

Status, branch configuration, check, and redeploy routes require the existing single-owner boundary: loopback access or successful HTTP Basic Auth. Possession of the RFS connection token does not authorize configuration or redeployment.

The feature is disabled by default and unavailable in packaged Desktop mode. The Server resolves one repository-owned script and supplies one fixed argument array without a shell. The validated effective branch occupies one fixed argument slot; browser input cannot alter the executable, remote, repository path, option set, or argument count. Status responses are bounded and exclude environment values, credentials, repository paths, and raw command output.

Remote browser access continues to require the bind, allowed-host, Basic Auth, and operator-managed HTTPS or trusted-private-network controls in [deployment security](./deployment-security.md).

## Code entry points

| File                                                                                                                               | Responsibility                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`scripts/start-huabu.sh`](../../scripts/start-huabu.sh)                                                                           | Path-independent tmux redeployment and readiness probe.                                   |
| [`scripts/canary-redeploy-runner.mjs`](../../scripts/canary-redeploy-runner.mjs)                                                   | Detached execution, persistent result state, and local logging.                           |
| [`scripts/start-web.mjs`](../../scripts/start-web.mjs)                                                                             | Captures repository root and deployed SHA for the standalone Server.                      |
| [`packages/shared/src/types/api/deployment.ts`](../../packages/shared/src/types/api/deployment.ts)                                 | Canary branch, status, configuration, and action wire contracts.                          |
| [`apps/server/src/modules/security/canary-redeploy.ts`](../../apps/server/src/modules/security/canary-redeploy.ts)                 | Configuration persistence, exact remote checks, concurrency, status, and runner launch.   |
| [`apps/server/src/modules/security/canary-redeploy.route.ts`](../../apps/server/src/modules/security/canary-redeploy.route.ts)     | Owner-only status, branch configuration, check, and redeploy endpoints.                   |
| [`apps/web/src/components/Settings/CanaryRedeploySettings.tsx`](../../apps/web/src/components/Settings/CanaryRedeploySettings.tsx) | Settings branch editor, status, check action, and branch-bound confirmed redeploy action. |
