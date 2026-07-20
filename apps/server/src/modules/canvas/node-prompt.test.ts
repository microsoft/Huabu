/**
 * Unit tests for the converged node → context assembly
 * ({@link describeNode} / {@link nodeLabel} / {@link renderNodes}).
 *
 * Focus: the ONE rule — the caller's own fields win, anything missing is
 * filled from the on-disk sidecar — plus the two agent-facing levels
 * (`preview` / `outline`), `rev` presence, the summary/preview split, the
 * null-store degenerate path, and the `<node/>` rendering.
 */

import { describe, expect, it } from 'vitest';

import { describeNode, nodeLabel, renderNodes } from './node-prompt.js';

import type { CanvasStore, NodeContent } from '../storage/canvas-store.js';

/** Minimal stub: only `readNode` is exercised by this module. */
function stubStore(
  nodes: Record<string, Partial<NodeContent> | null>,
): CanvasStore {
  return {
    readNode(id: string): NodeContent | null {
      const n = nodes[id];
      if (n == null) return null;
      return {
        nodeId: id,
        type: 'note',
        label: null,
        content: '',
        ...n,
      } as NodeContent;
    },
  } as unknown as CanvasStore;
}

describe('describeNode — preview level', () => {
  it('fills label + body from the sidecar when the caller has none', () => {
    const store = stubStore({
      n1: { label: 'My Note', content: 'Hello body', summary: 'Abstract' },
    });
    const node = describeNode(store, { id: 'n1', type: 'note' }, 'preview');

    expect(node.label).toBe('My Note');
    // filename is derived from the (sidecar) label — the real on-disk path,
    // NOT a dead nodes/<id>.md.
    expect(node.filename).toBe('nodes/My Note.md');
    expect(node.summary).toBe('Abstract');
    expect(node.preview).toBe('Hello body');
    expect(typeof node.rev).toBe('string');
  });

  it("prefers the caller's own field over the sidecar (own wins)", () => {
    const store = stubStore({ n1: { label: 'Sidecar Label', content: 'x' } });
    const node = describeNode(
      store,
      { id: 'n1', type: 'note', label: 'Wire Label' },
      'preview',
    );
    expect(node.label).toBe('Wire Label');
    expect(node.filename).toBe('nodes/Wire Label.md');
  });

  it('omits rev / summary / preview for a node with no body or summary', () => {
    const store = stubStore({ n1: { label: 'Empty' } }); // content '' by default
    const node = describeNode(store, { id: 'n1', type: 'note' }, 'preview');
    expect(node.label).toBe('Empty');
    expect(node.rev).toBeUndefined();
    expect(node.summary).toBeUndefined();
    expect(node.preview).toBeUndefined();
  });

  it('emits summary and preview as INDEPENDENT fields', () => {
    const store = stubStore({
      n1: { label: 'L', summary: 'The abstract', content: 'The full body' },
    });
    const node = describeNode(store, { id: 'n1', type: 'note' }, 'preview');
    expect(node.summary).toBe('The abstract');
    expect(node.preview).toBe('The full body');
  });

  it('hashes rev from a source-backed node with no body', () => {
    const store = stubStore({
      n1: { type: 'image', label: 'Pic', src: 'artifacts/a.png' },
    });
    const node = describeNode(store, { id: 'n1', type: 'image' }, 'preview');
    expect(typeof node.rev).toBe('string');
    expect(node.preview).toBeUndefined(); // src is not a content preview
  });

  it('with a null store, uses only the caller-supplied fields', () => {
    const node = describeNode(
      null,
      { id: 'n1', type: 'note', label: 'L', content: 'Body' },
      'preview',
    );
    expect(node.label).toBe('L');
    expect(node.preview).toBe('Body');
    expect(typeof node.rev).toBe('string');
  });

  it('with meta=null, forces "no sidecar" even when a store is passed', () => {
    const store = stubStore({ n1: { label: 'Sidecar', content: 'x' } });
    const node = describeNode(
      store,
      { id: 'n1', type: 'note', label: 'Own' },
      'preview',
      null,
    );
    expect(node.label).toBe('Own');
    expect(node.preview).toBeUndefined(); // sidecar body ignored
  });
});

describe('describeNode — outline level', () => {
  it('layers spatial metadata on top of the sidecar-sourced fields', () => {
    const store = stubStore({
      n1: { label: 'Node', content: 'Body', summary: 'Sum' },
    });
    const node = describeNode(
      store,
      {
        id: 'n1',
        type: 'note',
        position: { x: 10, y: 20 },
        size: { width: 30, height: 40 },
        parentFrame: { id: 'f1', label: 'Frame' },
        style: { color: 'red' },
      },
      'outline',
    );
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.size).toEqual({ width: 30, height: 40 });
    expect(node.parentFrame).toEqual({ id: 'f1', label: 'Frame' });
    expect(node.style).toEqual({ color: 'red' });
    expect(node.label).toBe('Node');
    expect(node.summary).toBe('Sum');
    expect(node.preview).toBe('Body');
    expect(typeof node.rev).toBe('string');
    // absolutePosition defaults to position when the caller omits it.
    expect(node.absolutePosition).toEqual({ x: 10, y: 20 });
  });

  it('carries an explicit absolutePosition distinct from parent-local position', () => {
    const store = stubStore({ n1: { label: 'Node' } });
    const node = describeNode(
      store,
      {
        id: 'n1',
        type: 'note',
        position: { x: 50, y: 60 },
        absolutePosition: { x: 1050, y: 560 },
        size: { width: 30, height: 40 },
        parentFrame: { id: 'f1', label: 'Frame' },
      },
      'outline',
    );
    expect(node.position).toEqual({ x: 50, y: 60 });
    expect(node.absolutePosition).toEqual({ x: 1050, y: 560 });
  });
});

describe('nodeLabel', () => {
  it('returns the sidecar label', () => {
    const store = stubStore({ n1: { label: 'Frame Title' } });
    expect(nodeLabel(store, 'n1')).toBe('Frame Title');
  });

  it('returns undefined when the node has no sidecar or no label', () => {
    const store = stubStore({ n1: null, n2: { label: null } });
    expect(nodeLabel(store, 'n1')).toBeUndefined();
    expect(nodeLabel(store, 'n2')).toBeUndefined();
  });
});

describe('renderNodes', () => {
  it('emits all present attributes and omits absent ones', () => {
    const xml = renderNodes([
      {
        id: 'n1',
        type: 'note',
        label: 'L',
        filename: 'nodes/L.md',
        rev: 'abc',
        summary: 'S',
        preview: 'P',
      },
      { id: 'n2', type: 'image' },
    ]);
    expect(xml).toBe(
      '<node id="n1" type="note" label="L" file="nodes/L.md" rev="abc" summary="S" preview="P" />\n' +
        '<node id="n2" type="image" />',
    );
  });

  it('escapes XML-significant characters in attribute values', () => {
    const xml = renderNodes([
      { id: 'n1', type: 'note', label: 'a & b < c > "d"', preview: 'x\ny' },
    ]);
    expect(xml).toContain('label="a &amp; b &lt; c &gt; &quot;d&quot;"');
    // newlines in preview are flattened to a space by escapeXmlAttr.
    expect(xml).toContain('preview="x y"');
  });

  it('renders the summary/preview split from describeNode end-to-end', () => {
    const store = stubStore({
      n1: { label: 'Risks', summary: 'FX exposure', content: 'Full body' },
    });
    const node = describeNode(store, { id: 'n1', type: 'note' }, 'preview');
    const xml = renderNodes([node]);
    expect(xml).toBe(
      '<node id="n1" type="note" label="Risks" file="nodes/Risks.md" ' +
        `rev="${node.rev}" summary="FX exposure" preview="Full body" />`,
    );
  });
});
