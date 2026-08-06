import type { ManagedSetupProgress } from './types.js';

export interface ManagedSetupWorkerRequest {
  packageDir: string;
  harness: string;
  workingDirPath: string;
}

export type ManagedSetupWorkerMessage =
  | { type: 'progress'; progress: ManagedSetupProgress }
  | { type: 'completed'; workingDirPath: string }
  | {
      type: 'failed';
      error: {
        code: 'setup_failed';
        message: string;
      };
    };
