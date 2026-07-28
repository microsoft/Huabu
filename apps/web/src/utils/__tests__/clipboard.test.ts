import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  copyCanvasClipboard,
  parseSedimentClipboard,
  parseSedimentClipboardHtml,
  parseSedimentImageClipboard,
  readSedimentClipboardPayload,
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

class TestClipboardItem {
  readonly values: Record<string, Blob | Promise<Blob>>;

  constructor(values: Record<string, Blob | Promise<Blob>>) {
    this.values = values;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it('copies an image as an image only, with no text/plain', async () => {
    const imageBlob = new Blob(['png'], { type: 'image/png' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(imageBlob, { status: 200 })),
    );

    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText,
    } as unknown as Clipboard);

    const payload = JSON.stringify({ __sediment_nodes__: [imageNode] });
    await copyCanvasClipboard({
      payload,
      image: { src: '/image.png', label: 'Diagram' },
    });

    // The clipboard must be written exactly once; an extra `writeText` would
    // consume the copy gesture's user activation and make this write fail.
    expect(writeText).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0][0][0] as TestClipboardItem;

    // Pasting an image outside Huabu must produce an image and nothing else.
    expect(item.values['text/plain']).toBeUndefined();

    await expect(item.values['image/png']).resolves.toMatchObject({
      type: 'image/png',
    });

    // The payload rides along in text/html and survives a round trip.
    const html = await new Response(await item.values['text/html']).text();
    expect(parseSedimentClipboardHtml(html)).toBe(payload);
  });

  it('copies non-image nodes as readable text plus the html payload', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText,
    } as unknown as Clipboard);

    const payload = JSON.stringify({ __sediment_nodes__: [] });
    await copyCanvasClipboard({ payload, plainText: 'Hello <world>' });

    expect(writeText).not.toHaveBeenCalled();
    const item = write.mock.calls[0][0][0] as TestClipboardItem;

    const plain = await new Response(await item.values['text/plain']).text();
    expect(plain).toBe('Hello <world>');

    // Rich-text targets that prefer html must see the same text, escaped, and
    // Huabu must still recover the payload from it.
    const html = await new Response(await item.values['text/html']).text();
    expect(html).toContain('Hello &lt;world&gt;');
    expect(parseSedimentClipboardHtml(html)).toBe(payload);
  });

  it('keeps the line structure of multi-line text in text/html', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText: vi.fn(),
    } as unknown as Clipboard);

    await copyCanvasClipboard({
      payload: 'node payload',
      plainText: 'First line\nSecond line\n\nSecond note',
    });

    const item = write.mock.calls[0][0][0] as TestClipboardItem;
    const html = await new Response(await item.values['text/html']).text();

    // Raw newlines would collapse into spaces in a rich-text target, so the
    // note would paste as one run-on line.
    expect(html).toContain('First line<br>Second line<br><br>Second note');
    expect(html).not.toContain('\n');

    const plain = await new Response(await item.values['text/plain']).text();
    expect(plain).toBe('First line\nSecond line\n\nSecond note');
  });

  it('omits text/plain when the selection has no textual form', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText: vi.fn(),
    } as unknown as Clipboard);

    await copyCanvasClipboard({ payload: 'node payload', plainText: '' });

    const item = write.mock.calls[0][0][0] as TestClipboardItem;
    expect(item.values['text/plain']).toBeUndefined();
    expect(item.values['text/html']).toBeDefined();
  });

  it('keeps the node payload when a non-image write fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const write = vi.fn().mockRejectedValue(new Error('not allowed'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText,
    } as unknown as Clipboard);

    await copyCanvasClipboard({ payload: 'node payload', plainText: 'Note' });

    expect(writeText).toHaveBeenCalledWith('node payload');
  });

  it('keeps the node payload when the image write fails', async () => {
    const imageBlob = new Blob(['png'], { type: 'image/png' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(imageBlob, { status: 200 })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const write = vi.fn().mockRejectedValue(new Error('not allowed'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText,
    } as unknown as Clipboard);

    await expect(
      copyCanvasClipboard({
        payload: 'node payload',
        image: { src: '/image.png' },
      }),
    ).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith('node payload');
  });

  it('keeps the node payload when the image cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const write = vi
      .fn()
      .mockImplementation(async (items: TestClipboardItem[]) => {
        await Promise.all(Object.values(items[0].values));
      });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText,
    } as unknown as Clipboard);

    await expect(
      copyCanvasClipboard({
        payload: 'node payload',
        image: { src: '/image.png' },
      }),
    ).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith('node payload');
  });

  it('falls back to the node payload when ClipboardItem is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn();
    vi.stubGlobal('ClipboardItem', undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText,
    } as unknown as Clipboard);

    await copyCanvasClipboard({
      payload: 'node payload',
      image: { src: '/image.png' },
    });

    expect(writeText).toHaveBeenCalledWith('node payload');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('Sediment clipboard payload reading', () => {
  const payload = JSON.stringify({
    __sediment_nodes__: [imageNode],
    __sediment_canvas_id__: 'canvas-source',
  });

  const makeDataTransfer = (values: Record<string, string>) =>
    ({
      getData: (type: string) => values[type] ?? '',
    }) as unknown as DataTransfer;

  it('prefers the payload carried in text/html', () => {
    const encoded = btoa(
      String.fromCharCode(...new TextEncoder().encode(payload)),
    );
    const data = makeDataTransfer({
      'text/html': `<img src="data:image/png;base64,AAAA" data-sediment-nodes="${encoded}">`,
      'text/plain': 'Diagram',
    });

    expect(readSedimentClipboardPayload(data)).toBe(payload);
    expect(
      parseSedimentClipboard(readSedimentClipboardPayload(data)),
    ).toMatchObject({ srcCanvasId: 'canvas-source' });
  });

  it('falls back to text/plain for payloads written by older builds', () => {
    const data = makeDataTransfer({ 'text/plain': payload });

    expect(readSedimentClipboardPayload(data)).toBe(payload);
  });

  it('ignores html that carries no Huabu payload', () => {
    expect(parseSedimentClipboardHtml('<p>hello</p>')).toBeNull();
    expect(parseSedimentClipboardHtml('')).toBeNull();
    expect(
      parseSedimentClipboardHtml('<img data-sediment-nodes="not base64!!">'),
    ).toBeNull();
  });

  it('round-trips payloads containing non-Latin1 characters', () => {
    const unicodePayload = JSON.stringify({
      __sediment_nodes__: [{ ...imageNode, data: { label: '认知负荷理论' } }],
    });
    const encoded = btoa(
      String.fromCharCode(...new TextEncoder().encode(unicodePayload)),
    );

    expect(
      parseSedimentClipboardHtml(`<img data-sediment-nodes="${encoded}">`),
    ).toBe(unicodePayload);
  });
});
