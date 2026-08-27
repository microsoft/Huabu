// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { shouldCanvasSearchOwnKeyboard } from './canvasSearchKeyboard';

describe('shouldCanvasSearchOwnKeyboard', () => {
  it('keeps navigation ownership in the search input and result list', () => {
    const searchInput = document.createElement('input');
    searchInput.dataset.canvasSearchInput = 'true';

    const results = document.createElement('div');
    results.dataset.canvasSearchResults = '';
    const resultButton = document.createElement('button');
    results.appendChild(resultButton);

    expect(shouldCanvasSearchOwnKeyboard(searchInput)).toBe(true);
    expect(shouldCanvasSearchOwnKeyboard(resultButton)).toBe(true);
  });

  it('keeps ownership when React Flow focuses a plain canvas node', () => {
    const canvas = document.createElement('div');
    canvas.dataset.canvasRoot = '';
    const node = document.createElement('div');
    canvas.appendChild(node);

    expect(shouldCanvasSearchOwnKeyboard(node)).toBe(true);
  });

  it('yields to chat and canvas editors while search remains open', () => {
    const chatInput = document.createElement('textarea');
    const canvas = document.createElement('div');
    canvas.dataset.canvasRoot = '';
    const noteEditor = document.createElement('div');
    noteEditor.setAttribute('contenteditable', 'true');
    const editorText = document.createElement('span');
    noteEditor.appendChild(editorText);
    canvas.appendChild(noteEditor);

    expect(shouldCanvasSearchOwnKeyboard(chatInput)).toBe(false);
    expect(shouldCanvasSearchOwnKeyboard(noteEditor)).toBe(false);
    expect(shouldCanvasSearchOwnKeyboard(editorText)).toBe(false);
  });

  it('yields to controls outside the search results', () => {
    const button = document.createElement('button');

    expect(shouldCanvasSearchOwnKeyboard(button)).toBe(false);
  });
});
