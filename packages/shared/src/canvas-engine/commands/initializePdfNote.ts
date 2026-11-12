// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import createNodes from './createNodes.js';
import { noop, type CommandDefinition } from './types.js';
import { createId, type CanvasCommand } from '../../index.js';
import { hidePdfNotes, pdfNoteId, validPdfNoteLink } from '../pdfNotes.js';

type Cmd = Extract<CanvasCommand, { type: 'INITIALIZE_PDF_NOTE' }>;

const initializePdfNote: CommandDefinition<Cmd> = {
  meta: { snapshot: 'yes', requiresEdgeReroute: false },
  handler(cmd, state) {
    const pdf = state.nodes.find((node) => node.id === cmd.nodeId);
    if (!pdf) return noop(state, 'not-found');
    if (pdf.type !== 'pdf') return noop(state, 'invalid-target');
    const existingId = pdfNoteId(pdf);
    if (existingId) {
      return noop(
        state,
        validPdfNoteLink(pdf, existingId, state.nodes)
          ? 'no-op'
          : 'invalid-target',
      );
    }
    if (pdf.data.noteNodeId !== undefined) return noop(state, 'invalid-target');
    const id = createId('node');
    const created = createNodes.handler(
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id,
            nodeType: 'note',
            position: { x: 0, y: 0 },
            data: {
              content: '',
              origin: {
                type: state.source === 'agent' ? 'ai-operate' : 'user-created',
              },
            },
            selectOnCreate: false,
          },
        ],
      },
      state,
    );
    if (!created.applied) return created;
    const linked = { ...pdf, data: { ...pdf.data, noteNodeId: id } };
    const nodes = hidePdfNotes(
      created.nodes.map((node) => (node.id === pdf.id ? linked : node)),
    );
    return {
      ...created,
      nodes,
      mutatedNodes: nodes.filter(
        (node) => node.id === id || node.id === pdf.id,
      ),
    };
  },
};

export default initializePdfNote;
