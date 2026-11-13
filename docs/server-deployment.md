# Linux Server Deployment: systemd and Optional Caddy

This guide is for operators and agents managing a source checkout on a Linux host with systemd. The supported server-management path is a launch-only systemd user service; Caddy is an optional HTTPS reverse proxy. Nothing in Huabu installs services, changes firewall rules, configures DNS, or reboots the machine automatically. The application contract is documented in [Canary deployment](architecture/canary-deployment.md), [deployment security](architecture/deployment-security.md), and [credential storage](architecture/credential-storage.md).

## Responsibilities and safety boundaries

```text
Browser / Desktop -> Caddy HTTPS (optional) -> Huabu user service
                                             node scripts/start-web.mjs
Settings update -> independent update unit -> build-web.mjs --branch <branch>
                                           -> restart huabu.service -> readiness
```

| Entry point                        | Responsibility                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build:web`                   | Build the current checkout, including uncommitted changes, without checking Git cleanliness or changing branches.                                                 |
| `pnpm build:web --branch <branch>` | Require a clean worktree, fetch the exact branch from `origin`, check it out, fast-forward without discarding local work, install locked dependencies, and build. |
| `pnpm start:web`                   | Build the current checkout and then start it; intended for foreground/manual use, not systemd boot startup.                                                       |
| `node scripts/start-web.mjs`       | Load repository `.env` and existing instance configuration, then launch prepared artifacts without building.                                                      |
| `scripts/start-huabu.sh`           | Deprecated, unchanged tmux-only deployment helper; never use it to manage a systemd deployment.                                                                   |

Keep the existing non-root runtime account when migrating. Do not run Huabu as root. Obtain explicit operator approval before stopping services, installing units or Caddy, enabling linger, opening ports, changing DNS, or rebooting. Do not kill arbitrary listeners by port, overwrite an existing Caddyfile, reset Git history, delete data, or expose credentials while collecting diagnostics. Inspect existing configuration before editing it, and keep unrelated host services intact.

The checkout, dependencies, build artifacts, instance data, private configuration, and workspace must be accessible to the runtime account. Preserve the existing `HUABU_DATA_DIR`, `HUABU_CONFIG_DIR`, workspace, `.env`, and any environment-owned encryption key. Do not invent new directories while migrating: the default private configuration identity depends on the absolute data path. Back up data and its matching private key/configuration together; stop all Huabu and Vite processes sharing that credential store before setup or coordinated backups. Never print `.env`, private configuration, keys, or passwords into agent traces.

## 1. Prepare the checkout and persistent runtime

Run commands as the account that will own the Huabu service, from the checkout root. Install the Node version required by `.nvmrc` and the pnpm version pinned in `package.json`, then prepare dependencies and artifacts:

```bash
pnpm install --frozen-lockfile
pnpm build:web
node -p 'process.execPath'
command -v pnpm
```

Record a persistent absolute Node executable and pnpm executable directory. If `command -v` points into `/run/user/.../fnm_multishells`, resolve its symlink to the persistent installation and verify the target; never copy a session-only path into the unit. The unit needs an explicit PATH containing Node, pnpm, Git, and any locally installed agent commands. It does not initialize an interactive shell. When changing Node installations later, update and revalidate the unit's executable and PATH.

If Git access works only through an interactive credential prompt, configure unattended access for this account before enabling browser updates. Do not place tokens in remote URLs or unit arguments.

## 2. Configure access and preserve authentication

For loopback-only use, existing local setup is sufficient and Caddy is unnecessary. For remote browser access, configure the instance with login before putting a proxy in front of it. Stop all processes sharing the instance's credential store, then run:

```bash
pnpm run setup
```

Choose remote access, the canonical external origin such as `https://huabu.example.com`, an absolute workspace, and required login. The wizard saves the password in encrypted storage. Existing environment-owned values override setup and are never rewritten. If an explicit `HUABU_BIND_HOST=127.0.0.1` currently prevents remote setup, reconcile that override deliberately while services are stopped; do not silently discard existing deployment configuration.

For Caddy on the same host, after setup keep Huabu on loopback by merging these non-secret overrides into the existing repository-root `.env`:

```dotenv
SERVER_PORT=3001
HUABU_BIND_HOST=127.0.0.1
HUABU_PUBLIC_ORIGIN=https://huabu.example.com
```

The saved remote setup continues to supply the username, password, and workspace even with the loopback bind override. Retain the saved login requirement; remove any unintended `HUABU_AUTH_MODE=none` override only after reviewing the deployment's intended authentication. Alternatively, an existing complete environment-owned Basic Auth pair or configured Bubble identity remains supported; do not mix identity modes. This guide's verification commands assume Basic Auth.

Loopback binding is not authentication when a reverse proxy forwards public requests to that address. Caddy HTTPS alone does not add login. Do not disable Huabu authentication unless the operator deliberately supplies and verifies a separate authentication boundary; never inject shared owner credentials in Caddy headers to make requests pass.

For direct LAN access without Caddy, follow [deployment security](architecture/deployment-security.md) for non-loopback binds, canonical origins, login, and trusted-network/HTTPS requirements. Do not advertise a Caddy HTTPS origin unless that endpoint is actually configured and reachable.

## 3. Install the launch-only user unit

After approval, create the user unit directory:

```bash
mkdir -p ~/.config/systemd/user
```

If `~/.config/systemd/user/huabu.service` already exists, inspect it and merge changes rather than overwriting it. Otherwise, create it using this example:

```ini
[Unit]
Description=Huabu standalone web server
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
WorkingDirectory=/absolute/path/to/Huabu
ExecStart=/absolute/path/to/node /absolute/path/to/Huabu/scripts/start-web.mjs
Environment="PATH=/absolute/path/to/node-bin:/absolute/path/to/pnpm-bin:/usr/local/bin:/usr/bin:/bin"
Environment=HUABU_SERVICE_MANAGER=systemd-user
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Replace every `/absolute/path/...` placeholder with the actual checkout, persistent Node executable, and runtime PATH. Keep `HUABU_SERVICE_MANAGER=systemd-user`: it selects independent browser updates, not a tmux wrapper. Do not put `pnpm start:web`, Git operations, installation, or builds in `ExecStart`.

The application loads repository `.env` itself; do not also add `EnvironmentFile=` for that file. Existing process environment overrides `.env`, so preserve required host-managed overrides without duplicating stale application configuration or writing secrets into the unit. Keep secret files private to the runtime account.

Validate without starting the service:

```bash
systemd-analyze --user verify ~/.config/systemd/user/huabu.service
```

For boot startup without an SSH login, an administrator enables lingering for the runtime account:

```bash
sudo loginctl enable-linger <runtime-account>
loginctl show-user <runtime-account> -p Linger
```

Replace `<runtime-account>` before execution. Huabu is a user service: run `systemctl --user` as that account, not `sudo systemctl --user` as root. Do not substitute a system-level Huabu unit without also redesigning permissions for owner-triggered updates.

## 4. Cut over from tmux and verify

Choose a maintenance window. Identify the exact old Huabu tmux session and its processes, then stop only that deployment. Do not stop a shared tmux server or unrelated sessions. Do not invoke `scripts/start-huabu.sh`: it kills the configured port's listener and starts tmux again, regardless of `HUABU_SERVICE_MANAGER`.

After confirming the old service is stopped:

```bash
systemctl --user daemon-reload
systemctl --user enable --now huabu.service
systemctl --user status huabu.service --no-pager
journalctl --user -u huabu.service -n 100 --no-pager
```

The unit supervises only the Node process and its cgroup, restarts abnormal failures with a delay, and limits repeated starts. `active` is not application readiness. Check the original instance's login, existing workspace/data, connected agents, and readiness before declaring migration complete:

```bash
curl --fail --show-error --user owner \
  http://127.0.0.1:3001/api/deployment/readiness
```

Replace `owner` with the configured username and adjust the port if necessary. Passing only the username makes curl prompt for the password rather than placing it in shell history or argv. A successful response must report application readiness, not just an open TCP port.

## 5. Optional Caddy HTTPS

Install Caddy using its [official installation instructions](https://caddyserver.com/docs/install) after operator approval. Use its standard system-level `caddy.service` with a Caddyfile, independently of Huabu's user service. Do not run a second Caddy process alongside an already managed instance.

For the ordinary public-DNS HTTPS configuration, point the domain's relevant A/AAAA records to this host, ensure routing and firewall access to TCP 80/443, and check that no other service owns those listeners. Correct or remove an unusable AAAA record instead of leaving IPv6 clients pointed elsewhere. Keep Huabu's backend port private; it only needs loopback access. DNS challenges, existing TLS terminators, tunnels, and private PKI need their own operator-approved configuration rather than blindly following this public-DNS example.

Merge the following site into the existing `/etc/caddy/Caddyfile`; do not replace unrelated sites:

```caddyfile
huabu.example.com {
	reverse_proxy 127.0.0.1:3001
}
```

Replace the example hostname and align the upstream with `SERVER_PORT`. Caddy obtains/renews certificates and redirects HTTP to HTTPS for eligible public domains. The standard reverse proxy preserves the request Host and Authorization header and supports WebSockets and SSE, so do not strip credentials, rewrite Host to loopback, add path prefixes, or configure response buffering/timeouts that break long agent streams. See Caddy's [automatic HTTPS](https://caddyserver.com/docs/automatic-https), [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), and [service management](https://caddyserver.com/docs/running) references.

Validate the merged configuration before starting or reloading it:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

For a first installation, after validation and approval use `sudo systemctl enable --now caddy`. For an already running Caddy, use `sudo systemctl reload caddy`. Inspect status and logs:

```bash
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
curl --fail --show-error --user owner \
  https://huabu.example.com/api/deployment/readiness
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://huabu.example.com/api/deployment/readiness
```

With Basic Auth enabled, the authenticated request must succeed and the credential-free request must return 401. Verify the browser and a connected agent through the HTTPS origin too, including a streaming response. A 502 normally calls for checking Huabu's readiness/listener and the configured upstream; certificate errors call for checking DNS, reachability, and Caddy logs. Do not “fix” these errors by disabling authentication or opening the backend publicly.

## 6. Updates, configuration changes, and recovery

Manual branch deployment from an independent SSH session is:

```bash
node scripts/build-web.mjs --branch alpha &&
  systemctl --user restart huabu.service
```

Use the intended branch instead of `alpha`. The build requires a clean worktree and rejects divergent or local-only commits. Without `--branch`, `pnpm build:web` builds the existing working files, including uncommitted edits. Both modes are separate from service startup. After a successful restart, repeat authenticated readiness; command success or `active` alone is not enough.

For browser-triggered updates, set `HUABU_CANARY_REDEPLOY_ENABLED=1` in `.env`, restart Huabu, and configure/confirm the source branch in Settings. The runtime account must have unattended Git access, working pnpm, and a live systemd user manager. The independent transient `huabu-redeploy.service` builds first, restarts `huabu.service` only on build success, and records the final readiness result. Credentials are passed over stdin, not command arguments or unit environment properties. Update stage output is in `<actual-data-directory>/logs/canary-redeploy.log`; bounded result state is in `canary-redeploy-status.json`. Unit lifecycle diagnostics can also be inspected with `journalctl --user -u huabu-redeploy.service`.

Build-before-restart does not guarantee uninterrupted service: the same checkout, dependencies, and served assets are modified while the old process runs. There is no immutable release switch or automatic rollback. A failed build skips the intentional restart but can leave partial artifacts; repair and rebuild before restarting. If an update fails after restart, inspect both the service journal and update log instead of repeatedly triggering another deployment.

| Change or failure                  | Action                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime-only `.env` change         | `systemctl --user restart huabu.service`; no rebuild or daemon reload is needed.                                                                     |
| User unit edit                     | `systemctl --user daemon-reload`, then restart and verify readiness.                                                                                 |
| Caddyfile edit                     | Validate the complete merged file, then reload Caddy.                                                                                                |
| Failed build                       | Inspect the update log, repair the checkout/dependencies, and complete a successful build before restarting.                                         |
| Start-rate limit reached           | After fixing the cause, run `systemctl --user reset-failed huabu.service`, then restart and verify readiness.                                        |
| Data or credentials appear missing | Stop and inspect the runtime account and actual data/config/workspace paths; do not initialize replacement credentials or generate a new master key. |
| User manager unavailable           | Check that commands run as the runtime account and that its user manager/linger is configured; do not start a parallel tmux deployment.              |

Finally, after separate operator approval, reboot once and verify service availability externally before the first SSH login. Confirm `Linger=yes`, the enabled Huabu user unit, Caddy if used, and persistence of the same workspace and credentials. Until that acceptance check is done, report boot recovery as unverified.
