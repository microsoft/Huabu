// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface LocalAgentState {
  enabled: boolean;
  agentletId?: string;
  device?: { agentletId: string; displayName: string; version: string };
  status:
    | 'disabled'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'stopping'
    | 'authorization-required'
    | 'error';
  error: string | null;
}

export interface LocalAgentCredential {
  token: string;
  maxAgents: number;
}

export interface LocalAgentChild {
  readonly pid?: number;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
}

interface LocalAgentOptions {
  readDevice(): Promise<{
    agentletId: string;
    displayName: string;
    version: string;
  }>;
  readCredential(): LocalAgentCredential | null;
  saveCredential(credential: LocalAgentCredential | null): void;
  requestCredential(): Promise<LocalAgentCredential>;
  start(credential: LocalAgentCredential): Promise<LocalAgentChild>;
  forceTerminate(child: LocalAgentChild): void;
  onState(state: LocalAgentState): void;
}

export class LocalAgentManager {
  private state: LocalAgentState = {
    enabled: false,
    status: 'disabled',
    error: null,
  };
  private child: LocalAgentChild | null = null;
  private credential: LocalAgentCredential | null = null;
  private cleanupError: Error | null = null;
  private busy = false;
  private quitting = false;
  private stopPromise: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private connectionRejected = false;

  constructor(private readonly options: LocalAgentOptions) {}

  getState(): LocalAgentState {
    return { ...this.state };
  }

  private publish(patch: Partial<LocalAgentState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.getState());
  }

  async restore(): Promise<void> {
    this.busy = true;
    try {
      this.publish({ device: await this.options.readDevice() });
      if (this.quitting) return;
      this.credential = this.options.readCredential();
      if (!this.credential) return;
      this.publish({ enabled: true });
      await this.run();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
    }
  }

  async setEnabled(enabled: boolean): Promise<LocalAgentState> {
    if (this.busy || this.quitting) {
      throw new Error(
        'A local Agent connection operation is already in progress.',
      );
    }
    this.busy = true;
    try {
      if (!enabled) {
        this.credential = null;
        this.publish({ enabled: false });
        try {
          this.options.saveCredential(null);
        } catch (error) {
          this.publish({ enabled: true });
          throw error;
        } finally {
          await this.stop();
        }
        this.publish({
          status: 'disabled',
          error: null,
          agentletId: undefined,
        });
      } else {
        if (this.cleanupError) throw this.cleanupError;
        await this.stop();
        this.publish({
          status: 'connecting',
          error: null,
          agentletId: undefined,
        });
        this.connectionRejected = false;
        const credential = await this.options.requestCredential();
        if (this.quitting) return this.getState();
        this.options.saveCredential(credential);
        this.credential = credential;
        this.publish({ enabled: true });
        await this.run();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
    }
    return this.getState();
  }

  private fail(error: unknown): void {
    this.publish({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async run(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startChild();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startChild(): Promise<void> {
    if (this.cleanupError) throw this.cleanupError;
    if (this.child || !this.credential || this.quitting || !this.state.enabled)
      return;
    this.publish({ status: 'connecting', error: null });
    const child = await this.options.start(this.credential);
    this.child = child;
    let cleanupConfirmed = false;
    child.on('message', (message) => {
      if (
        this.child === child &&
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'agentlet:stopped'
      ) {
        cleanupConfirmed = true;
        return;
      }
      if (
        this.child !== child ||
        !this.state.enabled ||
        this.quitting ||
        this.state.status === 'stopping' ||
        !message ||
        typeof message !== 'object'
      )
        return;
      const event = 'type' in message ? message.type : undefined;
      if (event === 'agentlet:ready') {
        if (
          !('agentletId' in message) ||
          typeof message.agentletId !== 'string' ||
          !message.agentletId.trim()
        ) {
          this.fail(
            new Error('The local worker did not report its device ID.'),
          );
          return;
        }
        this.publish({
          status: 'connected',
          error: null,
          agentletId: message.agentletId,
        });
      } else if (event === 'agentlet:reconnecting') {
        this.publish({ status: 'reconnecting', error: null });
      } else if (event === 'agentlet:authorization-required') {
        this.connectionRejected = true;
        this.publish({
          status: 'authorization-required',
          error:
            'Device authorization was rejected. Reconnect to authorize this device again.',
        });
      } else if (event === 'agentlet:rejected') {
        this.connectionRejected = true;
        this.publish({
          status: 'error',
          error:
            'The server rejected this worker. Check whether another Agentlet on this computer is already connected, then reconnect.',
        });
      }
    });
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!cleanupConfirmed) {
        this.blockUnverifiedCleanup();
        return;
      }
      if (this.stopPromise || this.quitting || !this.state.enabled) return;
      if (this.connectionRejected) return;
      this.fail(
        new Error(
          `The local Agent worker stopped (${code}). Reconnect to start it again.`,
        ),
      );
    });
  }

  private blockUnverifiedCleanup(): Error {
    if (this.cleanupError) return this.cleanupError;
    let message =
      'Local Agent process-tree cleanup could not be confirmed. Stop any remaining local Agent tasks, then restart Huabu before reconnecting.';
    let removalFailed = false;
    this.credential = null;
    try {
      this.options.saveCredential(null);
    } catch (error) {
      removalFailed = true;
      message += ` Saved authorization could not be removed: ${error instanceof Error ? error.message : String(error)}. Disconnect again before restarting Huabu.`;
    }
    this.cleanupError = new Error(message);
    this.publish({ enabled: removalFailed, agentletId: undefined });
    this.fail(this.cleanupError);
    return this.cleanupError;
  }

  private async stop(): Promise<void> {
    await this.starting;
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      if (this.cleanupError) throw this.cleanupError;
      return;
    }
    this.publish({ status: 'stopping', error: null });
    this.stopPromise = new Promise<void>((resolve, reject) => {
      let escalated = false;
      let timer: ReturnType<typeof setTimeout>;
      const forceTerminate = () => {
        this.blockUnverifiedCleanup();
        timer = setTimeout(() => {
          reject(
            new Error(
              `${this.cleanupError?.message} Worker exit could not be confirmed after forced termination.`,
            ),
          );
        }, 2000);
        try {
          this.options.forceTerminate(child);
        } catch (error) {
          clearTimeout(timer);
          reject(
            new Error(
              `${this.cleanupError?.message} Forced worker termination failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return;
        }
      };
      timer = setTimeout(() => {
        escalated = true;
        timer = setTimeout(forceTerminate, 3000);
        try {
          child.postMessage({ type: 'agentlet:force-stop' });
        } catch {
          clearTimeout(timer);
          forceTerminate();
        }
      }, 12_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (this.cleanupError) reject(this.cleanupError);
        else if (code === 0 && !escalated) resolve();
        else
          reject(
            new Error(
              'Local Agent cleanup failed. Check for unfinished tasks before reconnecting.',
            ),
          );
      });
      try {
        child.postMessage({ type: 'agentlet:stop' });
      } catch (error) {
        clearTimeout(timer);
        this.fail(error);
        forceTerminate();
      }
    });
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async shutdown(): Promise<void> {
    this.quitting = true;
    await this.stop();
  }
}
