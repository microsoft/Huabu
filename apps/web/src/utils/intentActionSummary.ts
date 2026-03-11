import type { IntentAction } from '@sediment/shared';

export function getIntentActionLabel(action: IntentAction): string {
  switch (action.op) {
    case 'ADD_NODE':
      return action.label
        ? `Create ${action.nodeType} "${action.label}"`
        : `Create ${action.nodeType}`;
    case 'DELETE_NODES':
      return action.nodeIds.length === 1
        ? 'Delete 1 node'
        : `Delete ${action.nodeIds.length} nodes`;
    case 'CONNECT':
      return 'Connect nodes';
    case 'DISCONNECT':
      return 'Disconnect nodes';
    case 'UPDATE_NODE_DATA':
      return 'Update node content';
    case 'GROUP_INTO_FRAME':
      return action.frameLabel
        ? `Group into frame "${action.frameLabel}"`
        : 'Group into a new frame';
    case 'UNFRAME':
      return 'Dissolve frame';
    case 'MOVE_INTO_FRAME':
      return 'Move node into frame';
    case 'MOVE_OUT_OF_FRAME':
      return 'Move node out of frame';
    case 'SELECT_NODES':
      return action.nodeIds.length === 1
        ? 'Select 1 node'
        : `Select ${action.nodeIds.length} nodes`;
    case 'ALIGN_NODES':
      return `Align nodes ${action.direction}`;
    case 'SPREAD_NODES':
      return 'Spread selected nodes';
  }
}

export function summarizeIntentActions(actions: IntentAction[]): string {
  if (actions.length === 0) {
    return 'No actionable canvas changes were generated.';
  }

  const preview = actions.slice(0, 3).map(getIntentActionLabel).join(', ');
  const suffix = actions.length > 3 ? `, and ${actions.length - 3} more.` : '.';
  return `Applied ${actions.length} canvas change${actions.length > 1 ? 's' : ''}: ${preview}${suffix}`;
}
