/**
 * Embedded agentlet daemon supervisor.
 *
 * Sediment talks to external agent CLIs exclusively through agentlet's
 * **daemon mode**. Rather than asking the user to launch the daemon
 * manually from a terminal, the server forks it as a child process at
 * boot, manages its lifecycle, and exposes a small status surface
 * (`/api/acp/daemon`) so the UI can show a single troubleshooting
 * affordance when the supervisor gives up.
 *
 * ### Lifecycle
 *
 *   1. On Fastify `onListen` we read the host-injected connection
 *      token from {@link getDaemonAuth} and `child_process.fork` the
 *      agentlet daemon entry (an absolute path injected by the host)
 *      with `daemon --server ws://127.0.0.1:<port>/api/acp/agent
 *      --token <token> --allow-insecure`.
 *   2. On clean exit (code 0, no shutdown signal) we treat it as the
 *      daemon following our own shutdown request and stay offline.
 *   3. On unexpected exit (non-zero code OR signal OR crash) we
 *      schedule a restart with exponential backoff
 *      (1s → 2s → 5s → 10s → 10s …). After 5 failures inside any
 *      60s window we stop trying and surface `lastError` to the UI;
 *      the user can hit "Restart worker" from Settings to reset.
 *   4. Fastify `preClose` kills the child before upgraded sockets are drained.
 *
 * The daemon connects to the bridge over loopback HTTP with the
 * `--allow-insecure` flag (we use `ws://`, not `wss://`, because the
 * bridge is loopback-only and TLS would add zero value while breaking
 * dev). Token check is unchanged from a remote daemon connection.
 *
 * ### Status reporting
 *
 * `getDaemonStatus()` combines the supervisor's view (last error,
 * backoff schedule) with the Gateway's view (is a daemon
 * actually registered right now?). The UI uses the merged snapshot
 * to decide whether to show the amber troubleshooting block.
 *
 * ### Entry resolution
 *
 * The agentlet daemon entry is resolved by the **host** (which owns
 * deployment-layout knowledge — dev vs bundled paths) and passed to
 * {@link DaemonSupervisor.attach} as an absolute `daemonEntryPath`.
 * If the path does not exist the supervisor surfaces a permanent
 * `lastError` and the bridge is effectively disabled until the user
 * installs / configures the daemon.
 */

import { fork } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { getDaemonAuth } from './daemon-auth.js';
import { getAgentletGateway } from './gateway-mount.js';

import type { AgentletStatus } from '@agenetes/protocol';
import type { FastifyInstance } from 'fastify';
import type { ChildProcess } from 'node:child_process';

/** Backoff schedule for restarts after an unexpected daemon exit. */
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

/**
 * If the daemon fails this many times inside a {@link FAILURE_WINDOW_MS}
 * window, the supervisor gives up and surfaces `lastError` so the UI
 * can prompt the user to investigate (and click "Restart worker").
 */
const MAX_FAILURES_IN_WINDOW = 5;
const FAILURE_WINDOW_MS = 60_000;

/** Grace period before we treat a started daemon as "stable". */
const STABLE_AFTER_MS = 5_000;

/**
 * Map a daemon-reported log level (string) to one of pino's standard
 * method names. Unknown values fall back to the caller-provided default.
 */
const DAEMON_LEVELS = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const);
type DaemonLevel = typeof DAEMON_LEVELS extends Set<infer T> ? T : never;

interface PinoLikeLogger {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
}

/**
 * Forward the daemon's stdout/stderr to our pino logger, parsing each
 * line as JSON whenever possible so the daemon's `event`, `level`,
 * `daemonId`, … fields surface as first-class pino bindings instead
 * of a nested string blob inside `msg`.
 *
 * Behaviour:
 *   - Lines are buffered across chunk boundaries; partial trailing
 *     content waits for the next chunk (or stream end).
 *   - Lines that parse as a JSON object with a recognised `level`
 *     are re-emitted at the matching pino level. Daemon-side fields
 *     (`event`, `daemonId`, `ts`, …) become top-level bindings.
 *   - Lines that don't parse are forwarded verbatim at `fallbackLevel`
 *     (typically `debug` for stdout, `warn` for stderr). This keeps
 *     ad-hoc `console.log` / crash stack traces visible.
 *   - The daemon's `ts` field is preserved alongside pino's own
 *     `time` (when the server received the chunk). The slight skew is
 *     usually < 100ms but tracking both lets us spot pipe backpressure.
 */
function forwardDaemonOutput(
  stream: NodeJS.ReadableStream,
  log: PinoLikeLogger,
  fallbackLevel: DaemonLevel,
): void {
  let buffer = '';

  const emitLine = (line: string): void => {
    const trimmed = line.trimEnd();
    if (!trimmed) return;

    // Fast-path: only attempt JSON parse for object-shaped lines.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const rawLevel = typeof parsed.level === 'string' ? parsed.level : '';
        const level = (
          DAEMON_LEVELS.has(rawLevel as DaemonLevel)
            ? (rawLevel as DaemonLevel)
            : fallbackLevel
        ) satisfies DaemonLevel;

        // Strip pino-reserved keys from the daemon payload to avoid
        // double-emit / collision. We surface the daemon's level via
        // the method we call; its `time` would shadow pino's own.
        const { level: _level, time: _time, pid: _pid, ...rest } = parsed;
        void _level;
        void _time;
        void _pid;

        const event = typeof rest.event === 'string' ? rest.event : undefined;
        const msgField = typeof rest.msg === 'string' ? rest.msg : undefined;
        const msg = msgField ?? event ?? 'agentlet-daemon event';

        log[level]({ source: 'agentlet-daemon', ...rest }, msg);
        return;
      } catch {
        // Fall through to verbatim path on malformed JSON.
      }
    }

    log[fallbackLevel]({ source: 'agentlet-daemon' }, trimmed);
  };

  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      emitLine(buffer.slice(0, newlineIdx));
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf('\n');
    }
  });

  // Flush any trailing partial line when the stream ends so we don't
  // silently drop the last record on a daemon that exits without a
  // trailing newline.
  const flush = (): void => {
    if (buffer.length === 0) return;
    emitLine(buffer);
    buffer = '';
  };
  stream.once('end', flush);
  stream.once('close', flush);
}

/**
 * Best-effort: remove the legacy pairing-ticket persistence file from
 * pre-daemon installs. Idempotent. Errors other than ENOENT are
 * logged but never thrown.
 */
function cleanupLegacyTicketsFile(app: FastifyInstance, dataDir: string): void {
  try {
    const legacy = join(dataDir, 'acp-tickets.json');
    if (existsSync(legacy)) {
      unlinkSync(legacy);
      app.log.info(
        `[acp/supervisor] removed legacy ${legacy} (bridge-pairing flow has been replaced by an embedded daemon)`,
      );
    }
  } catch (err) {
    app.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[acp/supervisor] could not remove legacy acp-tickets.json',
    );
  }
}

interface SupervisorState {
  child: ChildProcess | null;
  /** Epoch ms of recent unexpected exits, used for failure-window logic. */
  recentFailures: number[];
  /** Set by `close()` to suppress the restart-on-exit handler. */
  shuttingDown: boolean;
  /** Set true while we are forking or running the child. */
  starting: boolean;
  /** Pending backoff timer, cleared on restart() / close(). */
  restartTimer: NodeJS.Timeout | null;
  /** Most recent supervisor error message ('' on the happy path). */
  lastError: string;
  /** Epoch ms of the next scheduled restart attempt, or null when idle. */
  nextRestartAt: number | null;
  /** True after the supervisor has decided to stop retrying. */
  givenUp: boolean;
}

/** Host-injected configuration for {@link DaemonSupervisor.attach}. */
export interface AttachOptions {
  /**
   * Absolute path to the agentlet daemon entry script. The host
   * resolves this from its own deployment layout (dev vs bundled) and
   * passes a ready absolute path — this package never resolves it.
   */
  daemonEntryPath: string;
  /** Absolute directory for host-owned persistent state. */
  dataDir: string;
  /** Machine identity shared by the daemon and Gateway authenticator. */
  agentletId?: string;
  /**
   * Host-namespaced environment isolation for the forked daemon (and,
   * transitively, every agent it spawns). When `hostEnvPrefix` is set,
   * any inherited variable whose name starts with that prefix is
   * dropped before the daemon inherits it, UNLESS the name is listed in
   * `hostEnvAllowlist`. Non-namespaced variables (`PATH`, `HOME`, …)
   * always pass through untouched.
   *
   * The agentlet transport is host-agnostic and must receive its host
   * coordinates through explicit injection (spawn `env`), never through
   * ambient inheritance — this keeps host secrets and unrelated host
   * config out of untrusted agent processes. The prefix + allowlist are
   * opaque host policy; this package never interprets their meaning.
   */
  hostEnvPrefix?: string;
  hostEnvAllowlist?: readonly string[];
}

/**
 * Drop host-namespaced variables from an inherited environment.
 *
 * Any key starting with `prefix` is removed unless it appears in
 * `allowlist`; every other key (including all non-namespaced OS /
 * toolchain variables) is preserved verbatim. Returns a fresh object;
 * the input is never mutated. A missing `prefix` is a no-op passthrough.
 */
export function filterHostNamespacedEnv(
  env: NodeJS.ProcessEnv,
  prefix: string | undefined,
  allowlist: readonly string[] | undefined,
): Record<string, string> {
  const allow = new Set(allowlist ?? []);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (prefix && key.startsWith(prefix) && !allow.has(key)) continue;
    out[key] = value;
  }
  return out;
}

class DaemonSupervisor {
  private app: FastifyInstance | null = null;
  private state: SupervisorState = {
    child: null,
    recentFailures: [],
    shuttingDown: false,
    starting: false,
    restartTimer: null,
    lastError: '',
    nextRestartAt: null,
    givenUp: false,
  };
  /** Cached fastify port resolved on first fork. */
  private serverPort = 0;
  /**
   * Absolute path to the agentlet daemon entry script, injected by the
   * host at {@link attach} time. The host owns deployment-layout
   * knowledge (dev vs bundled paths); this package never resolves it.
   */
  private daemonEntryPath = '';
  /**
   * Absolute directory for host-owned persistent state, injected at
   * {@link attach} time. Used only for legacy-ticket cleanup here.
   */
  private dataDir = '';
  private agentletId = '';
  private hostEnvPrefix: string | undefined;
  private hostEnvAllowlist: readonly string[] | undefined;

  /**
   * Install the supervisor on a Fastify app. Idempotent per-app —
   * calling twice on the same instance is a no-op.
   */
  attach(app: FastifyInstance, opts: AttachOptions): void {
    if (this.app) return;
    this.app = app;
    this.daemonEntryPath = opts.daemonEntryPath;
    this.dataDir = opts.dataDir;
    this.agentletId = opts.agentletId ?? hostname();
    this.hostEnvPrefix = opts.hostEnvPrefix;
    this.hostEnvAllowlist = opts.hostEnvAllowlist;

    cleanupLegacyTicketsFile(app, this.dataDir);

    // We use `onListen` (not `onReady`) because we need the actual
    // bound port: `onReady` fires *before* Fastify calls the
    // underlying `app.server.listen()`, so `app.server.address()`
    // returns `null` (or `{ port: 0 }`) at that point — and we'd
    // end up forking the daemon with `ws://127.0.0.1:0/...`, which
    // never connects. `onListen` fires after the OS-level bind so
    // the address is guaranteed to be populated with the real port.
    app.addHook('onListen', async () => {
      const addr = app.server.address();
      if (!addr || typeof addr === 'string') {
        // AF_UNIX bind (string) or no socket — the supervisor cannot
        // dial a path-based listener. Surface the error and stay offline.
        this.state.lastError =
          'Server is not bound to a TCP port; agentlet daemon disabled';
        this.state.givenUp = true;
        app.log.warn(`[acp/supervisor] ${this.state.lastError}`);
        return;
      }
      this.serverPort = addr.port;
      this.start();
    });

    app.addHook('preClose', async () => {
      this.close();
    });
  }

  /**
   * Force an immediate restart attempt, resetting backoff state.
   * Returns the post-restart status snapshot.
   *
   * Triggered by `POST /api/acp/daemon/restart` when the user clicks
   * the "Restart worker" button in Settings.
   */
  restart(): AgentletStatus {
    if (this.state.restartTimer) {
      clearTimeout(this.state.restartTimer);
      this.state.restartTimer = null;
    }
    this.state.recentFailures = [];
    this.state.givenUp = false;
    this.state.lastError = '';
    this.state.nextRestartAt = null;
    if (this.state.child) {
      // The exit handler will see `shuttingDown=false` and the cleared
      // backoff state, then re-fork immediately. Setting `starting`
      // briefly so concurrent `getStatus()` callers don't see "online".
      this.state.starting = true;
      this.state.child.kill('SIGTERM');
    } else {
      this.start();
    }
    return this.getStatus();
  }

  /**
   * Whether the supervisor has stopped attempting restarts (failure
   * budget exhausted, daemon entry not found, …). When `true`, callers
   * polling for the daemon to come online should short-circuit instead
   * of waiting out their full timeout — the daemon will not appear
   * without user intervention ("Restart worker" in Settings).
   */
  hasGivenUp(): boolean {
    return this.state.givenUp;
  }

  /**
   * Synchronous best-effort shutdown. Kills the child, clears every
   * timer, and prevents future restart attempts.
   */
  close(): void {
    this.state.shuttingDown = true;
    if (this.state.restartTimer) {
      clearTimeout(this.state.restartTimer);
      this.state.restartTimer = null;
    }
    if (this.state.child && !this.state.child.killed) {
      try {
        this.state.child.kill('SIGTERM');
      } catch {
        // Best-effort — the child may already be dead.
      }
    }
    this.state.child = null;
    this.state.starting = false;
    getDaemonAuth().close();
  }

  /**
   * Merge the supervisor's view with the Gateway's daemon
   * registry to produce the wire snapshot consumed by the UI.
   */
  getStatus(): AgentletStatus {
    const gateway = getAgentletGateway();
    const live = gateway?.getAgentlets({ status: 'connected' }) ?? [];
    const agentlet = live[0];

    if (agentlet) {
      return {
        online: true,
        agentletId: agentlet.agentletId,
        hostname: agentlet.agentletProfile?.machine?.hostname,
        platform: agentlet.agentletProfile?.machine?.platform,
        connectedAt: agentlet.connectedAt.toISOString(),
      };
    }

    const status: AgentletStatus = { online: false };
    if (this.state.lastError) status.lastError = this.state.lastError;
    if (this.state.nextRestartAt) {
      status.nextRestartAt = this.state.nextRestartAt;
    }
    return status;
  }

  /** Fork the daemon child. Called by attach() and the exit handler. */
  private start(): void {
    if (!this.app) return;
    if (this.state.shuttingDown) return;
    if (this.state.child) return; // already running

    const entry = this.daemonEntryPath;
    if (!entry || !existsSync(entry)) {
      this.state.lastError =
        'agentlet daemon entry not found (set HUABU_AGENTLET_DAEMON_PATH or rebuild)';
      this.state.givenUp = true;
      this.app.log.warn(`[acp/supervisor] ${this.state.lastError}`);
      return;
    }

    const token = getDaemonAuth().getToken();
    if (!token) {
      this.state.lastError =
        'connection token not set (mountAgenetes must inject it before the server binds)';
      this.state.givenUp = true;
      this.app.log.warn(`[acp/supervisor] ${this.state.lastError}`);
      return;
    }
    const serverUrl = `ws://127.0.0.1:${this.serverPort}/api/acp/agent`;
    const args = [
      'daemon',
      '--server',
      serverUrl,
      '--token',
      token,
      '--agentlet-id',
      this.agentletId,
      '--allow-insecure',
    ];

    this.state.starting = true;
    this.state.nextRestartAt = null;

    let child: ChildProcess;
    try {
      child = fork(entry, args, {
        // `silent` pipes stdio so we can forward the daemon's logs
        // through Fastify's logger; ignore stdin since the daemon
        // never reads from it.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // The daemon uses `process.exit` on fatal errors; avoid
        // inheriting our env wholesale to keep its config surface
        // minimal — only what `parseCli` reads matters. Host-namespaced
        // variables are stripped here (unless allow-listed) so host
        // secrets and config never reach the daemon or the agents it
        // spawns; the daemon receives its coordinates via CLI args and
        // agents via explicit spawn `env` injection.
        env: {
          ...filterHostNamespacedEnv(
            process.env,
            this.hostEnvPrefix,
            this.hostEnvAllowlist,
          ),
          AGENTLET_TOKEN: token,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.lastError = `Failed to fork agentlet daemon: ${message}`;
      this.state.starting = false;
      this.app.log.error(`[acp/supervisor] ${this.state.lastError}`);
      this.scheduleRestart();
      return;
    }

    this.state.child = child;
    this.state.lastError = '';

    const log = this.app.log;
    const startedAt = Date.now();
    log.info(
      { entry, serverUrl, pid: child.pid },
      '[acp/supervisor] agentlet daemon forked',
    );

    // Forward child stdout/stderr to our pino logger. Each line is
    // parsed as JSON and re-emitted at its self-reported level (info /
    // warn / error / …) with the daemon's `event`, `daemonId`, etc.
    // hoisted to first-class bindings — see {@link forwardDaemonOutput}.
    // Non-JSON lines (crash stack traces, stray `console.log`) are
    // forwarded verbatim at a sensible fallback level so they remain
    // searchable without polluting the warn/error tier.
    if (child.stdout) forwardDaemonOutput(child.stdout, log, 'debug');
    if (child.stderr) forwardDaemonOutput(child.stderr, log, 'warn');

    child.once('exit', (code, signal) => {
      // Distinguish supervisor-initiated kill from a daemon crash.
      // `shuttingDown` is the explicit teardown path; for all other
      // exits we schedule a restart unless the failure budget is spent.
      const unexpected = !this.state.shuttingDown;
      this.state.child = null;
      this.state.starting = false;

      if (!unexpected) {
        log.info(
          { code, signal },
          '[acp/supervisor] daemon exited (shutdown requested)',
        );
        return;
      }

      const lifespan = Date.now() - startedAt;
      log.warn(
        { code, signal, lifespanMs: lifespan, pid: child.pid },
        '[acp/supervisor] daemon exited unexpectedly',
      );

      // Only count short-lived exits against the failure budget. A
      // daemon that ran cleanly for >STABLE_AFTER_MS and then died is
      // probably hitting a transient issue (network, OOM) — we reset
      // the budget so a long-lived restart loop keeps recovering.
      if (lifespan < STABLE_AFTER_MS) {
        this.state.recentFailures.push(Date.now());
      } else {
        this.state.recentFailures = [];
      }
      this.state.lastError = `Daemon exited (code=${code ?? 'null'}, signal=${
        signal ?? 'null'
      })`;
      this.scheduleRestart();
    });

    child.once('error', (err) => {
      // `error` fires for spawn failures *before* `exit`. Capturing
      // here lets us surface the underlying ENOENT / EACCES message
      // rather than the meaningless `exit code=null, signal=null`.
      this.state.lastError = `agentlet daemon spawn error: ${err.message}`;
      log.error({ err }, '[acp/supervisor] agentlet daemon spawn error');
    });
  }

  /**
   * Queue the next restart attempt according to {@link RESTART_BACKOFF_MS},
   * or set `givenUp` when the failure budget is exhausted.
   */
  private scheduleRestart(): void {
    if (this.state.shuttingDown) return;

    // Prune failures outside the rolling window before counting.
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    this.state.recentFailures = this.state.recentFailures.filter(
      (t) => t > cutoff,
    );
    if (this.state.recentFailures.length >= MAX_FAILURES_IN_WINDOW) {
      this.state.givenUp = true;
      this.state.nextRestartAt = null;
      this.app?.log.warn(
        {
          failures: this.state.recentFailures.length,
          windowMs: FAILURE_WINDOW_MS,
        },
        '[acp/supervisor] daemon failed too many times — giving up until user restarts',
      );
      return;
    }

    // Step the backoff: failures.length-1 indexes the schedule; clamp
    // to the last slot so very long restart loops keep retrying every
    // 10s rather than ballooning unboundedly.
    const idx = Math.min(
      this.state.recentFailures.length,
      RESTART_BACKOFF_MS.length - 1,
    );
    const delay = RESTART_BACKOFF_MS[idx] ?? 10_000;
    this.state.nextRestartAt = Date.now() + delay;
    this.state.restartTimer = setTimeout(() => {
      this.state.restartTimer = null;
      this.start();
    }, delay);
    // `unref` so a pending restart timer never blocks Node from exiting.
    if (typeof this.state.restartTimer.unref === 'function') {
      this.state.restartTimer.unref();
    }
  }
}

let _supervisor: DaemonSupervisor | null = null;

/** Process-wide accessor. Created lazily so tests can reset state. */
export function getDaemonSupervisor(): DaemonSupervisor {
  if (!_supervisor) _supervisor = new DaemonSupervisor();
  return _supervisor;
}

/** Convenience for the route handler. */
export function getDaemonStatus(): AgentletStatus {
  return getDaemonSupervisor().getStatus();
}

/** Test-only — reset the singleton between vitest cases. */
export function _resetDaemonSupervisorForTests(): void {
  if (_supervisor) _supervisor.close();
  _supervisor = null;
}
