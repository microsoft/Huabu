# Alpha Canary Deployment

> Personal-development deployment workflow whose source branch defaults to `alpha`. This is not the stable release or promotion path.

## Branch and authorization model

`main` is the stable branch. `alpha` is the rolling integration branch and the compatibility-default source for the personal Canary. An owner may configure another branch, such as `x/alpha`, for one development deployment without changing the repository's issue-branch or promotion policy. Issue branches still start from `origin/alpha` and target `alpha`; promotion from `alpha` to `main` remains a separate reviewed action.

Canary use is additional end-to-end evidence only. It does not replace pull-request CI, review, documentation, release validation, or authorization to promote or publish.

## Configuration

These optional settings are specific to source-run personal Canary deployments and are not needed for ordinary local or remote use:

```dotenv
HUABU_CANARY_REDEPLOY_ENABLED=1
HUABU_CANARY_READINESS_TIMEOUT_SECONDS=300
```

Set them in the hosting Server's environment or repository-root `.env`, then restart the Server. The first enables owner-only redeployment controls; the second is a positive integer limiting the non-interactive readiness wait, in seconds, and defaults to 300. When invoking `scripts/start-huabu.sh` directly, export the timeout in the shell environment; the script does not read that setting from `.env` itself.

## Supported workflow

The supported helper runs from a source checkout. `pnpm start:web` runs `scripts/build-web.mjs` followed by `scripts/start-web.mjs`; `pnpm build:web` runs only the build. The build prepares Agentlet, Agenetes, client-runtime, shared code, the bundled Server, and the compiled SPA. Without `--branch`, it builds the current checkout without installing dependencies or requiring a clean worktree. `node scripts/build-web.mjs --branch <branch>` instead validates a bounded full branch ref, requires a clean checkout, fetches the exact branch from `origin`, checks out or creates the local tracking branch, and updates it with `--ff-only`. Divergent branches and local-only commits are rejected rather than overwritten or deployed. It then installs dependencies with `--frozen-lockfile` and builds; any failed step stops the command.

`scripts/start-web.mjs` only starts existing build artifacts; it never installs dependencies, changes branches, or builds. It loads the repository-root `.env` without overriding existing environment variables, preserves the existing data/configuration resolution, captures the startup commit in `HUABU_DEPLOYED_SHA`, and exports the resolved checkout root as `HUABU_REPO_ROOT` before loading the bundled Server. Production-style startup binds the fixed `SERVER_PORT` (default `3001`) and fails rather than selecting another port when it is unavailable. Build artifacts must be prepared before using this launch-only entry point.

Setting `HUABU_CANARY_REDEPLOY_ENABLED=1` enables an owner-only Settings surface. The selected branch is persisted as an application-global versioned record under `HUABU_DATA_DIR`; a missing record or explicit cleared value resolves to `alpha`. Malformed stored configuration fails explicitly rather than silently using the default.

Opening Settings compares the captured startup commit with the exact configured remote ref using shell-free `git ls-remote --exit-code --refs origin refs/heads/<branch>`. Branch syntax is checked as a bounded full Git branch ref and option-like leading `-` values are rejected. A configured ref that is invalid or unavailable fails explicitly and never falls back to `alpha`. The result identifies a different branch head; it does not independently attest CI status.

The owner confirms the effective branch displayed by Settings. The request carries that branch only as a freshness guard; the Server rejects it if it no longer matches persisted configuration, so the request cannot independently select a deployment target. The Server supplies the runner with one repository-owned deployment entry point and the captured branch. For systemd the entry point is `scripts/build-web.mjs`; for legacy tmux it is `scripts/start-huabu.sh`. The systemd runner executes this fixed sequence without a shell:

```text
node <repository>/scripts/build-web.mjs --branch <effective-branch>
systemctl --user restart huabu.service
authenticated readiness probe
```

The deployment persists the captured branch with `requested`, `running`, `succeeded`, or `failed` state under `HUABU_DATA_DIR` and appends a local log. With the default tmux backend the runner is a detached child. With `HUABU_SERVICE_MANAGER=systemd-user`, the Server starts it in the independent transient user unit `huabu-redeploy.service` through `systemd-run --user --pipe --collect --service-type=exec`. Admission uses a two-phase stdin handshake: the runner receives one newline-delimited environment object and reports readiness with its PID; the Server persists `running` with that PID before sending an explicit acceptance line. Only then may the runner touch shared status/log files or execute deployment stages. The Server waits up to ten seconds for readiness and closes the admission pipe on failure; EOF, invalid confirmation, or a ten-second runner-side admission timeout exits without deployment or status writes, so a late runner cannot overwrite a failed admission or a newer request. Launcher failures are recorded as failed admissions. The update unit has no lifecycle dependency on `huabu.service`, so stopping the Server and its cgroup does not terminate an admitted update. The `systemd-run` client may be terminated with the old Server, but its independently managed service continues.

The runner waits briefly before deployment so the Server can flush HTTP 202; that response means only that the runner started. The systemd path builds first and only restarts after a successful build, then waits for readiness on the fixed Server port. Build failure never intentionally stops or restarts the running service; restart failure skips readiness, and readiness timeout records a failed deployment. Success requires all three stages. The systemd path does not invoke `start-huabu.sh`, tmux, or port-based process termination.

The readiness probe receives the Server's effective Basic Auth credentials, including saved setup credentials, through child-only `HUABU_CANARY_BASIC_AUTH_USER` / `HUABU_CANARY_BASIC_AUTH_PASS`. They are not placed in arguments, persisted status, or global `process.env`, and do not become ordinary startup credential overrides for the replacement Server. For systemd updates, the child environment is delivered over an inherited stdin pipe, not unit environment properties, command arguments, or a request file on disk. The runner consumes that input before starting the deployment script. Direct script invocation still accepts the standard Basic Auth environment variables.

Only one check, configuration write, or redeployment admission may run at a time. A configuration write is rejected while a check or persisted runner is active, concurrent operations receive an explicit conflict, and an admitted redeployment cannot be retargeted. Persisted result status retains its captured branch so a later configuration can never make an older outcome appear to belong to another branch.

## Deprecated tmux compatibility

`scripts/start-huabu.sh` is deprecated for new server deployments but remains at its original path with its original tmux-only implementation and arguments. It is not a systemd wrapper. Its behavior remains available to existing manually managed deployments and to the legacy Settings runner when `HUABU_SERVICE_MANAGER=systemd-user` is absent.

The script requires a clean checkout, resolves the Server port from its environment, the checkout's `.env`, or `3001`, stops that port's listener, and removes the previous `app` tmux session. It fetches the exact branch from `origin`, checks out or creates the local tracking branch, fast-forwards it, installs locked dependencies, and starts `pnpm start:web` in tmux. Interactive use tails `/tmp/huabu-app.log`; `--non-interactive` performs its existing readiness wait.

The legacy path stops the service before fetch/install/build and can terminate an unrelated port owner. Do not invoke it against a systemd-managed deployment, even with `HUABU_SERVICE_MANAGER` exported: the unchanged script does not read that marker.

Both paths update one checkout in place. There is no rollback, immutable release directory, zero-downtime guarantee, container deployment, or automatic installation. Building before restarting avoids an intentional early shutdown, but fetch/install/build still modify the running service's source, dependencies, and served artifacts. A failed build can leave partial artifacts, so service preservation and safe crash recovery during an update are not guaranteed. Inspect the persisted runner status and log, then repair manually through SSH when needed.

## systemd user service

The opt-in unit example is embedded in the [server deployment guide](../server-deployment.md#3-install-the-launch-only-user-unit). It runs as the existing account, starts only previously built artifacts, and sets `HUABU_SERVICE_MANAGER=systemd-user` for independent Canary updates. It uses `Restart=on-failure`, a ten-second retry delay, and a five-starts-per-five-minutes limit. `KillMode=mixed` gives the main Node process the first termination signal so its shutdown hooks can close agents and storage; remaining cgroup processes are forcibly cleaned up on termination. Logs go to the journal. `active` means the process started, not that application readiness passed.

Installation and migration are explicit operator actions, not side effects of a build, Server startup, or update request. See the [server deployment guide](../server-deployment.md) for user-service installation, tmux migration, persistent runtime paths and data identity, optional Caddy HTTPS, manual updates, readiness, and recovery. Application `.env` remains loaded by `start-web.mjs`, not by systemd's `EnvironmentFile=`.

## Security boundary

Status, branch configuration, check, and redeploy routes require the existing single-owner boundary: loopback access or successful HTTP Basic Auth. Possession of the RFS connection token does not authorize configuration or redeployment.

The feature is disabled by default and unavailable in packaged Desktop mode. The Server resolves one repository-owned script and supplies one fixed argument array without a shell. The validated effective branch occupies one fixed argument slot; browser input cannot alter the executable, remote, repository path, option set, or argument count. Status responses are bounded and exclude environment values, credentials, repository paths, and raw command output.

Remote browser access continues to require the bind, allowed-host, Basic Auth, and operator-managed HTTPS or trusted-private-network controls in [deployment security](./deployment-security.md).

## Code entry points

| File                                                                                                                               | Responsibility                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`scripts/build-web.mjs`](../../scripts/build-web.mjs)                                                                             | Canonical web build and optional exact-origin branch update with locked installation.     |
| [`scripts/start-huabu.sh`](../../scripts/start-huabu.sh)                                                                           | Deprecated, unchanged tmux-only deployment and readiness probe.                           |
| [`scripts/canary-redeploy-runner.mjs`](../../scripts/canary-redeploy-runner.mjs)                                                   | Independent execution, stdin environment handoff, persistent result state, and logging.   |
| [`scripts/start-web.mjs`](../../scripts/start-web.mjs)                                                                             | Captures repository root and deployed SHA for the standalone Server.                      |
| [`packages/shared/src/types/api/deployment.ts`](../../packages/shared/src/types/api/deployment.ts)                                 | Canary branch, status, configuration, and action wire contracts.                          |
| [`apps/server/src/modules/security/canary-redeploy.ts`](../../apps/server/src/modules/security/canary-redeploy.ts)                 | Configuration persistence, exact remote checks, concurrency, status, and runner launch.   |
| [`apps/server/src/modules/security/canary-redeploy.route.ts`](../../apps/server/src/modules/security/canary-redeploy.route.ts)     | Owner-only status, branch configuration, check, and redeploy endpoints.                   |
| [`apps/web/src/components/Settings/CanaryRedeploySettings.tsx`](../../apps/web/src/components/Settings/CanaryRedeploySettings.tsx) | Settings branch editor, status, check action, and branch-bound confirmed redeploy action. |
