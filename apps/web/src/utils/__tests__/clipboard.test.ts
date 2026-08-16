// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  copyCanvasClipboard,
  copyImageToClipboard,
  parseHuabuClipboard,
  parseHuabuClipboardHtml,
  parseHuabuImageClipboard,
  readHuabuClipboardPayload,
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

describe('Huabu clipboard parsing', () => {
  it('parses canvas nodes, edges, and source canvas id', () => {
    const payload = JSON.stringify({
      __huabu_nodes__: [imageNode],
      __huabu_edges__: [{ id: 'edge-1' }],
      __huabu_canvas_id__: 'canvas-source',
    });

    expect(parseHuabuClipboard(payload)).toEqual({
      nodes: [imageNode],
      edges: [{ id: 'edge-1' }],
      srcCanvasId: 'canvas-source',
    });
  });

  it('extracts image metadata from an image-only selection', () => {
    const payload = JSON.stringify({
      __huabu_nodes__: [imageNode],
      __huabu_edges__: [],
      __huabu_canvas_id__: 'canvas-source',
    });

    expect(parseHuabuImageClipboard(payload)).toEqual({
      images: [{ src: 'artifact-image.png', label: 'Diagram' }],
      srcCanvasId: 'canvas-source',
    });
  });

  it('does not treat mixed node selections as pasted images', () => {
    const payload = JSON.stringify({
      __huabu_nodes__: [
        imageNode,
        { id: 'node-note', type: 'note', data: { content: 'Text' } },
      ],
    });

    expect(parseHuabuImageClipboard(payload)).toBeNull();
  });

  it('rejects malformed and empty payloads', () => {
    expect(parseHuabuClipboard('not json')).toBeNull();
    expect(
      parseHuabuClipboard(JSON.stringify({ __huabu_nodes__: [] })),
    ).toBeNull();
    expect(
      parseHuabuImageClipboard(
        JSON.stringify({
          __huabu_nodes__: [{ id: 'node-image', type: 'image', data: {} }],
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

    const payload = JSON.stringify({ __huabu_nodes__: [imageNode] });
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
    expect(parseHuabuClipboardHtml(html)).toBe(payload);
  });

  it('copies image pixels without Huabu metadata for the explicit image action', async () => {
    const imageBlob = new Blob(['png'], { type: 'image/png' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(imageBlob, { status: 200 })),
    );
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
    } as unknown as Clipboard);

    await copyImageToClipboard('/image.png');

    const item = write.mock.calls[0][0][0] as TestClipboardItem;
    expect(Object.keys(item.values)).toEqual(['image/png']);
    const copied = await item.values['image/png'];
    expect(copied.type).toBe('image/png');
    expect(await copied.text()).toBe('png');
  });

  it('rejects explicit image copy when image clipboard writes are unavailable', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      writeText: vi.fn(),
    } as unknown as Clipboard);

    await expect(copyImageToClipboard('/image.svg')).rejects.toThrow(
      'Image clipboard writes are unavailable',
    );
  });

  it('falls back to an image element when createImageBitmap cannot decode SVG', async () => {
    const svg = new Blob(
      ['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>'],
      { type: 'image/svg+xml' },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(svg, { status: 200 })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockRejectedValue(new Error('unsupported')),
    );
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 20;
        naturalHeight = 10;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-svg');
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const png = new Blob(['converted'], { type: 'image/png' });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(png),
    );
    const write = vi
      .fn()
      .mockImplementation(async (items: TestClipboardItem[]) => {
        await Promise.all(Object.values(items[0].values));
      });
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
    } as unknown as Clipboard);

    await copyImageToClipboard('/image.svg');

    expect(drawImage).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-svg');
  });

  it('copies non-image nodes as readable text plus the html payload', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', TestClipboardItem);
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      write,
      writeText,
    } as unknown as Clipboard);

    const payload = JSON.stringify({ __huabu_nodes__: [] });
    await copyCanvasClipboard({ payload, plainText: 'Hello <world>' });

    expect(writeText).not.toHaveBeenCalled();
    const item = write.mock.calls[0][0][0] as TestClipboardItem;

    const plain = await new Response(await item.values['text/plain']).text();
    expect(plain).toBe('Hello <world>');

    // Rich-text targets that prefer html must see the same text, escaped, and
    // Huabu must still recover the payload from it.
    const html = await new Response(await item.values['text/html']).text();
    expect(html).toContain('Hello &lt;world&gt;');
    expect(parseHuabuClipboardHtml(html)).toBe(payload);
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

describe('Huabu clipboard payload reading', () => {
  const payload = JSON.stringify({
    __huabu_nodes__: [imageNode],
    __huabu_canvas_id__: 'canvas-source',
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
      'text/html': `<img src="data:image/png;base64,AAAA" data-huabu-nodes="${encoded}">`,
      'text/plain': 'Diagram',
    });

    expect(readHuabuClipboardPayload(data)).toBe(payload);
    expect(parseHuabuClipboard(readHuabuClipboardPayload(data))).toMatchObject({
      srcCanvasId: 'canvas-source',
    });
  });

  it('falls back to text/plain for payloads written by older builds', () => {
    const data = makeDataTransfer({ 'text/plain': payload });

    expect(readHuabuClipboardPayload(data)).toBe(payload);
  });

  it('ignores html that carries no Huabu payload', () => {
    expect(parseHuabuClipboardHtml('<p>hello</p>')).toBeNull();
    expect(parseHuabuClipboardHtml('')).toBeNull();
    expect(
      parseHuabuClipboardHtml('<img data-huabu-nodes="not base64!!">'),
    ).toBeNull();
  });

  it('round-trips payloads containing non-Latin1 characters', () => {
    const unicodePayload = JSON.stringify({
      __huabu_nodes__: [{ ...imageNode, data: { label: '认知负荷理论' } }],
    });
    const encoded = btoa(
      String.fromCharCode(...new TextEncoder().encode(unicodePayload)),
    );

    expect(parseHuabuClipboardHtml(`<img data-huabu-nodes="${encoded}">`)).toBe(
      unicodePayload,
    );
  });
});
