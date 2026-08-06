// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { variantForInternalTool } from './assistant-parts.js';

describe('variantForInternalTool', () => {
  it.each(['space_commands', 'canvas_commands'])(
    'normalizes %s to the canonical Space command renderer',
    (toolName) => {
      expect(variantForInternalTool(toolName)).toBe('space_commands');
    },
  );

  it.each(['get_space_outline', 'get_canvas_outline'])(
    'keeps %s compatible with the agent-tool renderer',
    (toolName) => {
      expect(variantForInternalTool(toolName)).toBe('agent_tool');
    },
  );

  it.each(['inspect_edges', 'fs_write'])(
    'routes %s through the self-describing agent-tool renderer',
    (toolName) => {
      expect(variantForInternalTool(toolName)).toBe('agent_tool');
    },
  );
});
