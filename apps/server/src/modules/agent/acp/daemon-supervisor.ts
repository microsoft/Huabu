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
 *   1. On Fastify `onReady` we mint a fresh 256-bit token, store it
 *      in {@link getDaemonAuth}, and `child_process.fork` the agentlet
 *      daemon entry with `daemon --server ws://127.0.0.1:<port>/api/
 *      acp/agent --token <token> --allow-insecure`.
 *   2. On clean exit (code 0, no shutdown signal) we treat it as the
 *      daemon following our own shutdown request and stay offline.
 *   3. On unexpected exit (non-zero code OR signal OR crash) we
 *      schedule a restart with exponential backoff
 *      (1s → 2s → 5s → 10s → 10s …). After 5 failures inside any
 *      60s window we stop trying and surface `lastError` to the UI;
 *      the user can hit "Restart worker" from Settings to reset.
 *   4. `app.onClose` kills the child cleanly.
 *
 * The daemon connects to the bridge over loopback HTTP with the
 * `--allow-insecure` flag (we use `ws://`, not `wss://`, because the
 * bridge is loopback-only and TLS would add zero value while breaking
 * dev). Token check is unchanged from a remote daemon connection.
 *
 * ### Status reporting
 *
 * `getDaemonStatus()` combines the supervisor's view (last error,
 * backoff schedule) with the agentlet server's view (is a daemon
 * actually registered right now?). The UI uses the merged snapshot
 * to decide whether to show the amber troubleshooting block.
 *
 * ### Entry resolution
 *
 * We look for the agentlet daemon entry in this order:
 *
 *   1. `HUABU_AGENTLET_DAEMON_PATH` env var — explicit override.
 *   2. `<bundleDir>/agentlet/index.js` — packaged Electron layout
 *      (tsup copies the daemon bundle next to `server.js`).
 *   3. `<repoRoot>/external/agentlet/packages/local/dist/index.js`
 *      — monorepo dev layout (relative to this source file).
 *
 * The first existing path wins. If none resolves the supervisor
 * surfaces a permanent `lastError` and the bridge is effectively
 * disabled until the user installs / configures the daemon.
 */

import { fork } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDaemonAuth } from './daemon-auth.js';
import { getAgentletServer } from './server-mount.js';
import { getDataDir } from '../../../data-dir.js';

import type { AcpAgentletStatus } from '@sediment/shared';
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
 * Resolve the absolute path to the agentlet daemon entry script.
 * Returns `null` when no candidate exists — the caller surfaces a
 * permanent supervisor error in that case.
 */
function resolveDaemonEntry(): string | null {
  const env = process.env.HUABU_AGENTLET_DAEMON_PATH;
  if (env && existsSync(env)) return env;

  // import.meta.url resolves to this source file in dev (tsx) and to
  // the bundled server.js in production (every module collapses into
  // the same file under tsup --bundle). Two candidates handle both.
  const here = dirname(fileURLToPath(import.meta.url));

  // Production: dist-bundle/server.js → dist-bundle/agentlet/index.js
  const bundled = resolve(here, 'agentlet', 'index.js');
  if (existsSync(bundled)) return bundled;

  // Dev: apps/server/src/modules/agent/acp/daemon-supervisor.ts
  //   → external/agentlet/packages/local/dist/index.js
  const dev = resolve(
    here,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'external',
    'agentlet',
    'packages',
    'local',
    'dist',
    'index.js',
  );
  if (existsSync(dev)) return dev;

  return null;
}

/**
 * Best-effort: remove the legacy pairing-ticket persistence file from
 * pre-daemon installs. Idempotent. Errors other than ENOENT are
 * logged but never thrown.
 */
function cleanupLegacyTicketsFile(app: FastifyInstance): void {
  try {
    const legacy = resolve(getDataDir(), 'acp-tickets.json');
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
   * Install the supervisor on a Fastify app. Idempotent per-app —
   * calling twice on the same instance is a no-op.
   */
  attach(app: FastifyInstance): void {
    if (this.app) return;
    this.app = app;

    cleanupLegacyTicketsFile(app);

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

    app.addHook('onClose', async () => {
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
  restart(): AcpAgentletStatus {
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
   * Merge the supervisor's view with the agentlet server's daemon
   * registry to produce the wire snapshot consumed by the UI.
   */
  getStatus(): AcpAgentletStatus {
    const server = getAgentletServer();
    const live = server?.getAgentlets() ?? [];
    const agentlet = live[0];

    if (agentlet) {
      return {
        online: true,
        agentletId: agentlet.sessionId,
        hostname: (agentlet.metadata as any)?.machine?.hostname,
        platform: (agentlet.metadata as any)?.machine?.platform,
        connectedAt: agentlet.connectedAt.toISOString(),
      };
    }

    const status: AcpAgentletStatus = { online: false };
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

    const entry = resolveDaemonEntry();
    if (!entry) {
      this.state.lastError =
        'agentlet daemon entry not found (set HUABU_AGENTLET_DAEMON_PATH or rebuild)';
      this.state.givenUp = true;
      this.app.log.warn(`[acp/supervisor] ${this.state.lastError}`);
      return;
    }

    const token = getDaemonAuth().rotateToken();
    const serverUrl = `ws://127.0.0.1:${this.serverPort}/api/acp/agent`;
    // Idle agentlet mode: no --agent flag means it waits for
    // server/spawn requests. The `daemon` subcommand selects the
    // daemon role of the agentlet CLI.
    const args = ['daemon', '--server', serverUrl, '--token', token, '--allow-insecure'];

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
        // minimal — only what `parseCli` reads matters.
        env: {
          ...process.env,
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
export function getDaemonStatus(): AcpAgentletStatus {
  return getDaemonSupervisor().getStatus();
}

/** Test-only — reset the singleton between vitest cases. */
export function _resetDaemonSupervisorForTests(): void {
  if (_supervisor) _supervisor.close();
  _supervisor = null;
}
