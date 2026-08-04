/**
 * Disk implementation of {@link LegacyNodeStore}.
 *
 * A deliberately narrow wrapper, not a re-export. `handle.nodes` must not be
 * castable back into the old all-purpose facade, so every call is forwarded
 * explicitly and the object exposes nothing else — no Space record, no log,
 * no title, no lifecycle.
 *
 * Every method is synchronous, and must stay so: the write coordinator's
 * atomicity argument is that read → revision check → apply → write contains
 * no `await` inside the canvas lock.
 */

import type { CanvasStore } from './legacy/canvas-store.js';
import type { NodeContent } from '../../../canvas/persistence-types.js';
import type {
  LegacyNodeStore,
  NodeWriteResult,
} from '../../ports/structured.js';

export class DiskLegacyNodeStore implements LegacyNodeStore {
  constructor(private readonly store: CanvasStore) {}

  readNode(nodeId: string): NodeContent | null {
    return this.store.readNode(nodeId);
  }

  async readAllNodes(options?: {
    strict?: boolean;
  }): Promise<Map<string, NodeContent>> {
    return this.store.readAllNodes(options);
  }

  async streamAllNodes(
    onNode: (id: string, content: NodeContent) => void,
    signal?: { readonly aborted: boolean },
  ): Promise<Map<string, NodeContent>> {
    return this.store.streamAllNodes(onNode, signal);
  }

  writeNode(
    nodeId: string,
    content: NodeContent,
    opts?: { strictRename?: boolean },
  ): NodeWriteResult {
    return this.store.writeNode(nodeId, content, opts ?? {});
  }

  deleteNode(nodeId: string): 'deleted' | 'absent' {
    return this.store.deleteNode(nodeId);
  }

  nodeIdForFilename(filename: string): string | null {
    return this.store.nodeIdForFilename(filename);
  }

  isDuplicateNode(nodeId: string): boolean {
    return this.store.isDuplicateNode(nodeId);
  }

  duplicateNodeFiles(nodeId: string): string[] {
    return this.store.duplicateNodeFiles(nodeId);
  }

  revalidateNodeForRead(nodeId: string): void {
    this.store.revalidateNodeForRead(nodeId);
  }

  isNodeWriteSuppressed(nodeId: string): boolean {
    return this.store.isNodeWriteSuppressed(nodeId);
  }
}
