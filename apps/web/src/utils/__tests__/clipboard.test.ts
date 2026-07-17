import { describe, expect, it } from 'vitest';

import {
  parseSedimentClipboard,
  parseSedimentImageClipboard,
} from '../io/clipboard';

const imageNode = {
  id: 'node-image',
  type: 'image',
  data: {
    type: 'image',
    src: 'artifact-image.png',
    label: 'Diagram',
  },
};

describe('Sediment clipboard parsing', () => {
  it('parses canvas nodes, edges, and source canvas id', () => {
    const payload = JSON.stringify({
      __sediment_nodes__: [imageNode],
      __sediment_edges__: [{ id: 'edge-1' }],
      __sediment_canvas_id__: 'canvas-source',
    });

    expect(parseSedimentClipboard(payload)).toEqual({
      nodes: [imageNode],
      edges: [{ id: 'edge-1' }],
      srcCanvasId: 'canvas-source',
    });
  });

  it('extracts image metadata from an image-only selection', () => {
    const payload = JSON.stringify({
      __sediment_nodes__: [imageNode],
      __sediment_edges__: [],
      __sediment_canvas_id__: 'canvas-source',
    });

    expect(parseSedimentImageClipboard(payload)).toEqual({
      images: [{ src: 'artifact-image.png', label: 'Diagram' }],
      srcCanvasId: 'canvas-source',
    });
  });

  it('does not treat mixed node selections as pasted images', () => {
    const payload = JSON.stringify({
      __sediment_nodes__: [
        imageNode,
        { id: 'node-note', type: 'note', data: { content: 'Text' } },
      ],
    });

    expect(parseSedimentImageClipboard(payload)).toBeNull();
  });

  it('rejects malformed and empty payloads', () => {
    expect(parseSedimentClipboard('not json')).toBeNull();
    expect(
      parseSedimentClipboard(JSON.stringify({ __sediment_nodes__: [] })),
    ).toBeNull();
    expect(
      parseSedimentImageClipboard(
        JSON.stringify({
          __sediment_nodes__: [{ id: 'node-image', type: 'image', data: {} }],
        }),
      ),
    ).toBeNull();
  });
});
