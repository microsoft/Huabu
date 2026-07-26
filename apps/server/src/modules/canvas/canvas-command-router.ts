import {
  createId,
  type CanvasCommand,
  type CanvasNodeId,
  type Point,
  type PreparedPortalNodePin,
  type PreparedPortalNodePinsCommand,
  type PreparedPortalSourcePosition,
} from '@sediment/shared';
import {
  createAbsolutePositionGetter,
  type NestableNode,
} from '@sediment/shared/canvas-engine';

import {
  executeOnServer,
  type ExecuteOnServerInput,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import {
  listCanvasDirEntries,
  requireWorldCanvasId,
} from '../storage/canvas-dirs.js';
import { getCanvasStore } from '../storage/index.js';

type PortalCommand = Extract<CanvasCommand, { type: 'SET_PORTAL_NODE_PINS' }>;

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
      `No canonical Portal exists for Canvas ${canvasId}; refresh the World before pinning`,
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

function nodeRefTarget(
  node: NestableNode,
): { canvasId: string; nodeId: string } | null {
  const target = (
    node.data as
      | { target?: { canvasId?: unknown; nodeId?: unknown } }
      | undefined
  )?.target;
  return node.type === 'nodeRef' &&
    typeof target?.canvasId === 'string' &&
    typeof target.nodeId === 'string'
    ? { canvasId: target.canvasId, nodeId: target.nodeId }
    : null;
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
 * Resolve workspace-owned mutations before entering the per-Canvas executor.
 */
export async function executeCanvasCommandsOnHost(
  input: ExecuteOnServerInput,
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

  const worldCanvasId = requireWorldCanvasId();
  const world = getCanvasStore(worldCanvasId).read() as StoredCanvas | null;
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
  const portalById = new Map(
    [...portalByCanvasId.values()].map((portal) => [portal.id, portal]),
  );
  const seenNodeRefTargets = new Set<string>();
  for (const node of worldNodes) {
    if (node.type !== 'nodeRef') continue;
    const target = nodeRefTarget(node);
    const parent = node.parentId ? portalById.get(node.parentId) : undefined;
    if (!target || portalTarget(parent) !== target.canvasId) {
      throw new CanvasCommandRoutingError(
        `Node reference ${node.id} is not parented to its matching Portal`,
      );
    }
    const key = pinKey(target.canvasId, target.nodeId);
    if (seenNodeRefTargets.has(key)) {
      throw new CanvasCommandRoutingError(
        `World contains duplicate references for ${target.canvasId}/${target.nodeId}`,
      );
    }
    seenNodeRefTargets.add(key);
  }

  const liveCanvasIds = new Set(
    listCanvasDirEntries().map((entry) => entry.id),
  );
  const sourceStates = new Map<string, SourceState | null>();
  const readSource = (canvasId: string): SourceState | null => {
    if (!sourceStates.has(canvasId)) {
      sourceStates.set(
        canvasId,
        sourceStateOf(getCanvasStore(canvasId).read() as StoredCanvas | null),
      );
    }
    return sourceStates.get(canvasId) ?? null;
  };

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
    const target = nodeRefTarget(node);
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
        pins.push({
          sourceCanvasId: update.sourceCanvasId,
          sourceNodeId,
          portalId: portal.id as CanvasNodeId,
          nodeRefId: createId('node') as CanvasNodeId,
          pinned: requested.get(key) ?? update.pinned,
        });
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
