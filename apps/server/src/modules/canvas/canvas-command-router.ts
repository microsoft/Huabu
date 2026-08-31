// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createId,
  type CanvasCommand,
  type CanvasNodeId,
  type Point,
  type PreparedPortalNodePin,
  type PreparedPortalNodePinsCommand,
  type PreparedPortalSourcePosition,
} from '@huabu/shared';
import {
  createAbsolutePositionGetter,
  getNodeSize,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import {
  executeOnServer,
  type ExecuteOnServerInput,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import { reconcileWorldPortals } from './world-portals.js';
import { createKeyedMutex } from '../../utils/keyed-mutex.js';
import { getStructuredStore, space } from '../storage/index.js';

type PortalCommand = Extract<CanvasCommand, { type: 'SET_PORTAL_NODE_PINS' }>;
const withPortalRoutingMutex = createKeyedMutex<string>();

interface StoredCanvas {
  state: {
    nodes?: unknown[];
  };
}

interface SourceState {
  nodes: NestableNode[];
  absolutePosition: (nodeId: string) => Point | null;
}

export class CanvasCommandRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasCommandRoutingError';
  }
}

export class MissingWorldPortalError extends CanvasCommandRoutingError {
  constructor(canvasId: string) {
    super(
      `Canvas ${canvasId} is not a live Space, so it owns no canonical Portal`,
    );
    this.name = 'MissingWorldPortalError';
  }
}

function pinKey(sourceCanvasId: string, sourceNodeId: string): string {
  return `${sourceCanvasId}\0${sourceNodeId}`;
}

function portalTarget(node: NestableNode | undefined): string | null {
  const target = (node?.data as { targetCanvasId?: unknown } | undefined)
    ?.targetCanvasId;
  return node?.type === 'canvasRef' && typeof target === 'string'
    ? target
    : null;
}

function referenceTarget(
  node: NestableNode,
): { canvasId: string; nodeId: string } | null {
  const target = (
    node.data as
      | { target?: { canvasId?: unknown; nodeId?: unknown } }
      | undefined
  )?.target;
  return (node.type === 'nodeRef' || node.type === 'frameRef') &&
    typeof target?.canvasId === 'string' &&
    typeof target.nodeId === 'string'
    ? { canvasId: target.canvasId, nodeId: target.nodeId }
    : null;
}

function sourceNodeById(
  source: SourceState,
  nodeId: string,
): NestableNode | null {
  return source.nodes.find((node) => node.id === nodeId) ?? null;
}

function sourceFrameAncestors(
  source: SourceState,
  node: NestableNode,
): NestableNode[] {
  const byId = new Map(
    source.nodes.map((candidate) => [candidate.id, candidate]),
  );
  const ancestors: NestableNode[] = [];
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId) {
    if (seen.has(parentId)) {
      throw new CanvasCommandRoutingError(
        'Source Canvas contains a parent cycle',
      );
    }
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.type === 'frame') ancestors.push(parent);
    parentId = parent.parentId;
  }
  return ancestors;
}

function sourceSubtree(
  source: SourceState,
  root: NestableNode,
): NestableNode[] {
  const result: NestableNode[] = [];
  const visited = new Set<string>();
  const visit = (node: NestableNode): void => {
    if (visited.has(node.id)) {
      throw new CanvasCommandRoutingError(
        'Source Canvas contains a parent cycle',
      );
    }
    visited.add(node.id);
    result.push(node);
    for (const child of source.nodes.filter(
      (candidate) => candidate.parentId === node.id,
    )) {
      visit(child);
    }
  };
  visit(root);
  return result;
}

function sourceStateOf(canvas: StoredCanvas | null): SourceState | null {
  if (!canvas || !Array.isArray(canvas.state.nodes)) return null;
  const nodes = canvas.state.nodes as NestableNode[];
  const getAbsolute = createAbsolutePositionGetter(
    new Map(nodes.map((node) => [node.id, node])),
  );
  return {
    nodes,
    absolutePosition: (nodeId) => getAbsolute(nodeId),
  };
}

function publicCommand(command: CanvasCommand): CanvasCommand {
  if (command.type !== 'SET_PORTAL_NODE_PINS') return command;
  const { prepared: _prepared, ...wireCommand } =
    command as PreparedPortalNodePinsCommand;
  return wireCommand;
}

function stripPreparedCommands(
  output: ExecuteOnServerOutput,
): ExecuteOnServerOutput {
  const commands = output.commands.map(publicCommand);
  return {
    ...output,
    commands,
    results: output.results.map((result, index) => ({
      ...result,
      command: commands[index] ?? publicCommand(result.command),
    })),
  };
}

function assertConsistentDesiredStates(
  commands: readonly PortalCommand[],
): void {
  const desired = new Map<string, boolean>();
  for (const command of commands) {
    for (const update of command.updates) {
      for (const sourceNodeId of update.sourceNodeIds) {
        const key = pinKey(update.sourceCanvasId, sourceNodeId);
        const previous = desired.get(key);
        if (previous !== undefined && previous !== update.pinned) {
          throw new CanvasCommandRoutingError(
            `Conflicting pin states for ${update.sourceCanvasId}/${sourceNodeId}`,
          );
        }
        desired.set(key, update.pinned);
      }
    }
  }
}

/**
 * Make sure every pinned source Space already owns its canonical Portal.
 *
 * Portals are maintained by World reconciliation, which used to run only
 * before a World read — so pinning from a Space that had never been seen in
 * an open World was rejected even though nothing was actually wrong.
 * Reconciling here restores the documented `live Space ⇔ one live canonical
 * Portal` invariant instead of inventing topology for this command, and is
 * skipped entirely once the Portals exist. Anything still missing afterwards
 * is a source Space that does not exist on disk.
 */
async function ensureCanonicalPortals(
  worldCanvasId: string,
  commands: readonly PortalCommand[],
): Promise<void> {
  const world = (await space(worldCanvasId).read()) as StoredCanvas | null;
  const targets = new Set<string>();
  for (const node of (world?.state.nodes ?? []) as NestableNode[]) {
    const target = portalTarget(node);
    if (target) targets.add(target);
  }
  const missing = commands.some((command) =>
    command.updates.some((update) => !targets.has(update.sourceCanvasId)),
  );
  if (!missing) return;
  await reconcileWorldPortals();
}

/**
 * Resolve workspace-owned mutations before entering the per-Canvas executor.
 */
export async function executeCanvasCommandsOnHost(
  input: ExecuteOnServerInput,
): Promise<ExecuteOnServerOutput> {
  return executeCanvasCommandsOnHostInternal(input, false);
}

async function executeCanvasCommandsOnHostInternal(
  input: ExecuteOnServerInput,
  routingLockHeld: boolean,
): Promise<ExecuteOnServerOutput> {
  const portalCommands = input.commands.filter(
    (command): command is PortalCommand =>
      command.type === 'SET_PORTAL_NODE_PINS',
  );
  if (portalCommands.length === 0) return executeOnServer(input);
  if (portalCommands.length !== input.commands.length) {
    throw new CanvasCommandRoutingError(
      'Portal Pin commands cannot be mixed with source-Canvas commands',
    );
  }

  assertConsistentDesiredStates(portalCommands);

  const spaces = getStructuredStore().spaces();
  const worldCanvasId = await spaces.worldId();
  if (!routingLockHeld) {
    return withPortalRoutingMutex(worldCanvasId, () =>
      executeCanvasCommandsOnHostInternal(input, true),
    );
  }
  await ensureCanonicalPortals(worldCanvasId, portalCommands);
  const world = (await space(worldCanvasId).read()) as StoredCanvas | null;
  if (!world || !Array.isArray(world.state.nodes)) {
    throw new CanvasCommandRoutingError('World Canvas is unavailable');
  }
  const worldNodes = world.state.nodes as NestableNode[];

  const portalByCanvasId = new Map<string, NestableNode>();
  for (const node of worldNodes) {
    const targetCanvasId = portalTarget(node);
    if (!targetCanvasId) continue;
    if (portalByCanvasId.has(targetCanvasId)) {
      throw new CanvasCommandRoutingError(
        `World contains duplicate Portals for Canvas ${targetCanvasId}`,
      );
    }
    portalByCanvasId.set(targetCanvasId, node);
  }
  const worldById = new Map(worldNodes.map((node) => [node.id, node]));
  const seenNodeRefTargets = new Set<string>();
  const existingReferenceByTarget = new Map<string, NestableNode>();
  for (const node of worldNodes) {
    if (node.type !== 'nodeRef' && node.type !== 'frameRef') continue;
    const target = referenceTarget(node);
    if (!target) {
      throw new CanvasCommandRoutingError(
        `Reference ${node.id} has no valid target`,
      );
    }
    const seenAncestors = new Set<string>([node.id]);
    let parentId = node.parentId;
    const directParent = parentId ? worldById.get(parentId) : undefined;
    if (
      directParent?.type !== 'canvasRef' &&
      directParent?.type !== 'frameRef'
    ) {
      throw new CanvasCommandRoutingError(
        `Reference ${node.id} has an invalid parent`,
      );
    }
    let matchingPortal = false;
    while (parentId) {
      if (seenAncestors.has(parentId)) {
        throw new CanvasCommandRoutingError(
          'World reference hierarchy is cyclic',
        );
      }
      seenAncestors.add(parentId);
      const parent = worldById.get(parentId);
      if (!parent) break;
      const parentTarget = referenceTarget(parent);
      if (
        parent.type === 'frameRef' &&
        parentTarget?.canvasId !== target.canvasId
      ) {
        break;
      }
      const canvasId = portalTarget(parent);
      if (canvasId) {
        matchingPortal = canvasId === target.canvasId;
        break;
      }
      parentId = parent.parentId;
    }
    if (!matchingPortal) {
      throw new CanvasCommandRoutingError(
        `Reference ${node.id} is not under its matching Portal`,
      );
    }
    const key = pinKey(target.canvasId, target.nodeId);
    if (seenNodeRefTargets.has(key)) {
      throw new CanvasCommandRoutingError(
        `World contains duplicate references for ${target.canvasId}/${target.nodeId}`,
      );
    }
    seenNodeRefTargets.add(key);
    existingReferenceByTarget.set(key, node);
  }

  const liveCanvasIds = new Set(
    (await spaces.list()).map((summary) => summary.canvasId),
  );

  // Every source Space the passes below can ask about, read once up front.
  // The set is knowable without running them: a source is either named by a
  // Portal-Pin update or referenced by a World node, and both are already in
  // hand. That keeps the reads to what this command touches while letting the
  // passes themselves stay synchronous.
  const referencedCanvasIds = new Set<string>();
  for (const command of portalCommands) {
    for (const update of command.updates) {
      referencedCanvasIds.add(update.sourceCanvasId);
    }
  }
  for (const node of worldNodes) {
    const target = referenceTarget(node);
    if (target) referencedCanvasIds.add(target.canvasId);
  }
  const sourceStates = new Map<string, SourceState | null>(
    await Promise.all(
      [...referencedCanvasIds].map(
        async (canvasId) =>
          [
            canvasId,
            sourceStateOf(
              (await space(canvasId).read()) as StoredCanvas | null,
            ),
          ] as const,
      ),
    ),
  );
  const readSource = (canvasId: string): SourceState | null =>
    sourceStates.get(canvasId) ?? null;

  const requested = new Map<string, boolean>();
  for (const command of portalCommands) {
    for (const update of command.updates) {
      const portal = portalByCanvasId.get(update.sourceCanvasId);
      if (!portal) {
        throw new MissingWorldPortalError(update.sourceCanvasId);
      }
      const source = liveCanvasIds.has(update.sourceCanvasId)
        ? readSource(update.sourceCanvasId)
        : null;
      for (const sourceNodeId of update.sourceNodeIds) {
        requested.set(
          pinKey(update.sourceCanvasId, sourceNodeId),
          update.pinned,
        );
        if (
          update.pinned &&
          (!source || !source.nodes.some((node) => node.id === sourceNodeId))
        ) {
          throw new CanvasCommandRoutingError(
            `Cannot pin missing source node ${update.sourceCanvasId}/${sourceNodeId}`,
          );
        }
      }
    }
  }

  const positionTargets = new Map<
    string,
    { canvasId: string; nodeId: string }
  >();
  for (const node of worldNodes) {
    const target = referenceTarget(node);
    if (target)
      positionTargets.set(pinKey(target.canvasId, target.nodeId), target);
  }
  for (const command of portalCommands) {
    for (const update of command.updates) {
      for (const sourceNodeId of update.sourceNodeIds) {
        if (!update.pinned) continue;
        positionTargets.set(pinKey(update.sourceCanvasId, sourceNodeId), {
          canvasId: update.sourceCanvasId,
          nodeId: sourceNodeId,
        });
      }
    }
  }

  const sourcePositions: PreparedPortalSourcePosition[] = [];
  for (const target of positionTargets.values()) {
    const position = readSource(target.canvasId)?.absolutePosition(
      target.nodeId,
    );
    if (!position) continue;
    sourcePositions.push({
      sourceCanvasId: target.canvasId as `canvas-${string}`,
      sourceNodeId: target.nodeId as CanvasNodeId,
      position,
    });
  }

  const preparedReferenceByTarget = new Map(existingReferenceByTarget);
  const removePreparedSubtree = (rootId: string): void => {
    const removedIds = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const reference of preparedReferenceByTarget.values()) {
        if (
          reference.parentId &&
          removedIds.has(reference.parentId) &&
          !removedIds.has(reference.id)
        ) {
          removedIds.add(reference.id);
          changed = true;
        }
      }
    }
    for (const [targetKey, reference] of preparedReferenceByTarget) {
      if (removedIds.has(reference.id)) {
        preparedReferenceByTarget.delete(targetKey);
      }
    }
  };

  const commands = portalCommands.map((command): CanvasCommand => {
    const pins: PreparedPortalNodePin[] = [];
    const seen = new Set<string>();
    for (const update of command.updates) {
      for (const sourceNodeId of update.sourceNodeIds) {
        const key = pinKey(update.sourceCanvasId, sourceNodeId);
        if (seen.has(key)) continue;
        seen.add(key);
        const portal = portalByCanvasId.get(update.sourceCanvasId);
        if (!portal) {
          throw new MissingWorldPortalError(update.sourceCanvasId);
        }
        const desiredPinned = requested.get(key) ?? update.pinned;
        const source = readSource(update.sourceCanvasId);
        const sourceNode = source ? sourceNodeById(source, sourceNodeId) : null;
        const existing = preparedReferenceByTarget.get(key);
        if (!desiredPinned || !source || !sourceNode) {
          pins.push({
            sourceCanvasId: update.sourceCanvasId,
            sourceNodeId,
            portalId: portal.id as CanvasNodeId,
            nodeRefId: (existing?.id ?? createId('node')) as CanvasNodeId,
            referenceType:
              existing?.type === 'frameRef' ? 'frameRef' : 'nodeRef',
            parentRefId: (existing?.parentId ?? portal.id) as CanvasNodeId,
            pinned: false,
          });
          if (existing) removePreparedSubtree(existing.id);
          continue;
        }
        if (sourceNode.type === 'frame' && existing?.type === 'frameRef') {
          pins.push({
            sourceCanvasId: update.sourceCanvasId,
            sourceNodeId,
            portalId: portal.id as CanvasNodeId,
            nodeRefId: existing.id as CanvasNodeId,
            referenceType: 'frameRef',
            parentRefId: (existing.parentId ?? portal.id) as CanvasNodeId,
            pinned: true,
          });
          continue;
        }

        const projected =
          sourceNode.type === 'frame'
            ? sourceSubtree(source, sourceNode)
            : [sourceNode];
        const projectedIds = new Map<string, CanvasNodeId>();
        for (const projectedNode of projected) {
          const projectedKey = pinKey(update.sourceCanvasId, projectedNode.id);
          projectedIds.set(
            projectedNode.id,
            (preparedReferenceByTarget.get(projectedKey)?.id ??
              createId('node')) as CanvasNodeId,
          );
        }

        for (const projectedNode of projected) {
          const projectedKey = pinKey(update.sourceCanvasId, projectedNode.id);
          if (requested.get(projectedKey) === false) {
            throw new CanvasCommandRoutingError(
              `Conflicting pin states for ${update.sourceCanvasId}/${projectedNode.id}`,
            );
          }
          seen.add(projectedKey);
          let parentRefId = portal.id as CanvasNodeId;
          let position: Point | undefined;
          if (projectedNode.id !== sourceNodeId) {
            const projectedParentId = projectedNode.parentId
              ? projectedIds.get(projectedNode.parentId)
              : undefined;
            if (projectedParentId) {
              parentRefId = projectedParentId;
              position = projectedNode.position;
            }
          } else {
            const nearestExistingAncestor = sourceFrameAncestors(
              source,
              sourceNode,
            ).find((ancestor) =>
              preparedReferenceByTarget.has(
                pinKey(update.sourceCanvasId, ancestor.id),
              ),
            );
            if (nearestExistingAncestor) {
              const ancestorRef = preparedReferenceByTarget.get(
                pinKey(update.sourceCanvasId, nearestExistingAncestor.id),
              );
              if (ancestorRef?.type === 'frameRef') {
                parentRefId = ancestorRef.id as CanvasNodeId;
                const nodeAbs = source.absolutePosition(projectedNode.id);
                const ancestorAbs = source.absolutePosition(
                  nearestExistingAncestor.id,
                );
                if (nodeAbs && ancestorAbs) {
                  position = {
                    x: nodeAbs.x - ancestorAbs.x,
                    y: nodeAbs.y - ancestorAbs.y,
                  };
                }
              }
            }
          }
          const size = getNodeSize(projectedNode);
          const projectedRefId = projectedIds.get(projectedNode.id);
          if (!projectedRefId) {
            throw new CanvasCommandRoutingError(
              `No reference ID was prepared for ${projectedNode.id}`,
            );
          }
          pins.push({
            sourceCanvasId: update.sourceCanvasId,
            sourceNodeId: projectedNode.id as CanvasNodeId,
            portalId: portal.id as CanvasNodeId,
            nodeRefId: projectedRefId,
            referenceType:
              projectedNode.type === 'frame' ? 'frameRef' : 'nodeRef',
            parentRefId,
            ...(position ? { position } : {}),
            ...(projectedNode.type === 'frame'
              ? {
                  size: {
                    width: size.width || 400,
                    height: size.height || 300,
                  },
                }
              : {}),
            pinned: true,
          });
          const existingProjected = preparedReferenceByTarget.get(projectedKey);
          const referenceType =
            projectedNode.type === 'frame' ? 'frameRef' : 'nodeRef';
          preparedReferenceByTarget.set(projectedKey, {
            ...(existingProjected ?? {}),
            id: projectedRefId,
            type: referenceType,
            parentId: parentRefId,
            position: existingProjected?.position ??
              position ??
              projectedNode.position ?? { x: 0, y: 0 },
            data: {
              ...(existingProjected?.data ?? {}),
              type: referenceType,
              target: {
                canvasId: update.sourceCanvasId,
                nodeId: projectedNode.id,
              },
            },
          });
        }
      }
    }
    return {
      ...command,
      prepared: { pins, sourcePositions },
    } as PreparedPortalNodePinsCommand;
  });

  const output = await executeOnServer({
    ...input,
    canvasId: worldCanvasId,
    commands,
    // Source-Space Pin/Unpin mutates World and deliberately does not create
    // source-scoped generic review records; the inverse Pin/Unpin is the
    // product-level recovery operation.
    computeChanges: false,
  });
  return stripPreparedCommands(output);
}
