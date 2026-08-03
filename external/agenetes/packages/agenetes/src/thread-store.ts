import { existsSync, readFileSync } from 'node:fs';

import {
  agentStateSnapshotSchema,
  workloadSpecSchema,
  type AgentStateSnapshot,
  type Namespace,
  type WorkloadSpec,
} from '@agenetes/protocol';
import { AgenetesError } from '@agenetes/runtime';

import { atomicWriteJson, sanitizeId } from './io.js';

export const THREAD_STORE_SCHEMA_VERSION = 'agenetes-v2';

/** One versioned entry in the per-namespace durable thread table. */
export interface ThreadRecord {
  readonly driverSchemaVersion: number;
  readonly spec: WorkloadSpec;
  readonly state: AgentStateSnapshot;
}

interface ThreadStoreFile {
  readonly schemaVersion: typeof THREAD_STORE_SCHEMA_VERSION;
  readonly records: Record<string, ThreadRecord>;
}

export interface ThreadStore {
  upsert(namespace: Namespace, threadId: string, record: ThreadRecord): void;
  get(namespace: Namespace, threadId: string): ThreadRecord | undefined;
  list(namespace: Namespace): ThreadRecord[];
  delete(namespace: Namespace, threadId: string): void;
}

export class InMemoryThreadStore implements ThreadStore {
  readonly #byNamespace = new Map<string, Map<string, ThreadRecord>>();

  #scope(namespace: Namespace): Map<string, ThreadRecord> {
    let scope = this.#byNamespace.get(namespace.name);
    if (!scope) {
      scope = new Map();
      this.#byNamespace.set(namespace.name, scope);
    }
    return scope;
  }

  upsert(namespace: Namespace, threadId: string, record: ThreadRecord): void {
    this.#scope(namespace).set(threadId, record);
  }

  get(namespace: Namespace, threadId: string): ThreadRecord | undefined {
    return this.#byNamespace.get(namespace.name)?.get(threadId);
  }

  list(namespace: Namespace): ThreadRecord[] {
    const scope = this.#byNamespace.get(namespace.name);
    return scope ? [...scope.values()] : [];
  }

  delete(namespace: Namespace, threadId: string): void {
    this.#byNamespace.get(namespace.name)?.delete(threadId);
  }
}

/** Restart-surviving ThreadStore backed by one `threads.json` per namespace. */
export class FileThreadStore implements ThreadStore {
  #path(namespace: Namespace): string {
    const root =
      namespace.storage?.root ??
      `${process.cwd()}/.agenetes/namespaces/${sanitizeId(namespace.name, 'namespace')}`;
    return `${root}/threads.json`;
  }

  #invalid(message: string, details?: unknown): never {
    throw new AgenetesError('invalid_persisted_record', message, details);
  }

  #parseRecord(
    namespace: Namespace,
    threadId: string,
    raw: unknown,
  ): ThreadRecord {
    if (!raw || typeof raw !== 'object') {
      return this.#invalid(`invalid persisted record '${threadId}'`);
    }
    const value = raw as Record<string, unknown>;
    if (
      !Number.isSafeInteger(value.driverSchemaVersion) ||
      (value.driverSchemaVersion as number) < 1
    ) {
      return this.#invalid(
        `invalid driver schema version for thread '${threadId}'`,
      );
    }
    const parsedSpec = workloadSpecSchema.safeParse(value.spec);
    if (!parsedSpec.success) {
      return this.#invalid(
        `invalid workload spec for thread '${threadId}'`,
        parsedSpec.error,
      );
    }
    if (parsedSpec.data.threadId !== threadId) {
      return this.#invalid(
        `thread record key '${threadId}' does not match spec threadId '${parsedSpec.data.threadId}'`,
      );
    }
    const parsedState = agentStateSnapshotSchema.safeParse(value.state);
    if (!parsedState.success) {
      return this.#invalid(
        `invalid state envelope for thread '${threadId}'`,
        parsedState.error,
      );
    }
    return {
      driverSchemaVersion: value.driverSchemaVersion as number,
      spec: {
        ...parsedSpec.data,
        namespace: {
          name: parsedSpec.data.namespace.name,
          ...(namespace.storage ? { storage: namespace.storage } : {}),
        },
      },
      state: parsedState.data,
    };
  }

  #writeFile(namespace: Namespace, file: ThreadStoreFile): void {
    const records = Object.fromEntries(
      Object.entries(file.records).map(([threadId, record]) => [
        threadId,
        {
          ...record,
          spec: {
            ...record.spec,
            namespace: { name: record.spec.namespace.name },
          },
        },
      ]),
    );
    atomicWriteJson(this.#path(namespace), { ...file, records });
  }

  #readFile(namespace: Namespace): ThreadStoreFile {
    const filePath = this.#path(namespace);
    if (!existsSync(filePath)) {
      return { schemaVersion: THREAD_STORE_SCHEMA_VERSION, records: {} };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    } catch (error) {
      return this.#invalid(`cannot read '${filePath}'`, error);
    }
    if (!raw || typeof raw !== 'object') {
      return this.#invalid(`invalid thread store '${filePath}'`);
    }
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== THREAD_STORE_SCHEMA_VERSION) {
      return this.#invalid(
        `unsupported thread store schema '${String(value.schemaVersion)}'`,
      );
    }
    if (!value.records || typeof value.records !== 'object') {
      return this.#invalid(`invalid thread records in '${filePath}'`);
    }

    const records: Record<string, ThreadRecord> = {};
    for (const [threadId, record] of Object.entries(
      value.records as Record<string, unknown>,
    )) {
      records[threadId] = this.#parseRecord(namespace, threadId, record);
    }
    return { schemaVersion: THREAD_STORE_SCHEMA_VERSION, records };
  }

  upsert(namespace: Namespace, threadId: string, record: ThreadRecord): void {
    sanitizeId(threadId, 'threadId');
    const file = this.#readFile(namespace);
    file.records[threadId] = record;
    this.#writeFile(namespace, file);
  }

  get(namespace: Namespace, threadId: string): ThreadRecord | undefined {
    return this.#readFile(namespace).records[threadId];
  }

  list(namespace: Namespace): ThreadRecord[] {
    return Object.values(this.#readFile(namespace).records);
  }

  delete(namespace: Namespace, threadId: string): void {
    const file = this.#readFile(namespace);
    if (!(threadId in file.records)) return;
    delete file.records[threadId];
    this.#writeFile(namespace, file);
  }
}
