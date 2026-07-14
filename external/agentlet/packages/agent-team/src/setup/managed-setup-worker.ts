import { runManagedSetup } from './run-setup.js';
import type {
  ManagedSetupWorkerMessage,
  ManagedSetupWorkerRequest,
} from './worker-protocol.js';

function send(message: ManagedSetupWorkerMessage): void {
  process.send?.(message);
}

function createWorkerLogger() {
  return {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
    success: (message: string) => console.log(message),
  };
}

const cancellation = new AbortController();
function cancelSetup(): void {
  if (cancellation.signal.aborted) return;
  cancellation.abort(new Error('Setup cancelled'));
  setTimeout(() => process.exit(143), 250).unref();
}

process.on('message', (message: unknown) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'cancel'
  ) {
    cancelSetup();
  }
});
process.once('SIGTERM', cancelSetup);

async function main(): Promise<void> {
  const serializedRequest = process.argv[2];
  if (!serializedRequest) {
    throw new Error('Missing managed setup worker request');
  }
  const request = JSON.parse(serializedRequest) as ManagedSetupWorkerRequest;
  await runManagedSetup({
    ...request,
    log: createWorkerLogger(),
    signal: cancellation.signal,
    onProgress: (progress) => send({ type: 'progress', progress }),
  });
  send({ type: 'completed', workingDirPath: request.workingDirPath });
}

main().catch((error: unknown) => {
  send({
    type: 'failed',
    error: {
      code: 'setup_failed',
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
