// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const FENCE_SENTINEL = '\x00\x00FENCE\x00\x00';

interface MarkdownSegment {
  text: string;
  isCode: boolean;
}

export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown) return markdown;
  const codeSegments: string[] = [];
  const stitched = splitFencedCode(markdown)
    .map((segment) => {
      if (!segment.isCode) return convertOutsideCode(segment.text);
      codeSegments.push(segment.text);
      return FENCE_SENTINEL;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  const parts = stitched.split(FENCE_SENTINEL);
  if (parts.length === 1) return parts[0];
  let result = parts[0];
  for (let index = 1; index < parts.length; index++) {
    result += codeSegments[index - 1] + parts[index];
  }
  return result;
}

function splitFencedCode(markdown: string): MarkdownSegment[] {
  const lines = markdown.split('\n');
  const segments: MarkdownSegment[] = [];
  let codeStart = -1;
  let outsideStart = 0;
  let fenceCharacter: string | null = null;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match && fenceCharacter === null) {
      if (outsideStart < index) {
        segments.push({
          text: lines.slice(outsideStart, index).join('\n'),
          isCode: false,
        });
      } else if (outsideStart === index && index > 0) {
        segments.push({ text: '', isCode: false });
      }
      codeStart = index;
      fenceCharacter = match[1][0];
      fenceLength = match[1].length;
      continue;
    }
    if (match && fenceCharacter !== null) {
      const character = match[1][0];
      const length = match[1].length;
      if (
        character === fenceCharacter &&
        length >= fenceLength &&
        line.trim().length === length
      ) {
        segments.push({
          text: lines.slice(codeStart, index + 1).join('\n'),
          isCode: true,
        });
        outsideStart = index + 1;
        codeStart = -1;
        fenceCharacter = null;
        fenceLength = 0;
      }
    }
  }

  if (fenceCharacter !== null) {
    segments.push({ text: lines.slice(codeStart).join('\n'), isCode: true });
  } else if (outsideStart < lines.length) {
    segments.push({
      text: lines.slice(outsideStart).join('\n'),
      isCode: false,
    });
  }
  return segments;
}

function convertOutsideCode(text: string): string {
  if (!text) return text;
  if (text.indexOf('`') === -1) return convertMathInPlain(text);
  const output: string[] = [];
  let index = 0;
  while (index < text.length) {
    const tickStart = text.indexOf('`', index);
    if (tickStart === -1) {
      output.push(convertMathInPlain(text.slice(index)));
      break;
    }
    if (tickStart > index) {
      output.push(convertMathInPlain(text.slice(index, tickStart)));
    }
    let runEnd = tickStart + 1;
    while (runEnd < text.length && text.charCodeAt(runEnd) === 96) runEnd++;
    const runLength = runEnd - tickStart;
    let closeStart = runEnd;
    let matched = -1;
    while (closeStart < text.length) {
      const candidate = text.indexOf('`', closeStart);
      if (candidate === -1) break;
      let candidateEnd = candidate + 1;
      while (
        candidateEnd < text.length &&
        text.charCodeAt(candidateEnd) === 96
      ) {
        candidateEnd++;
      }
      if (candidateEnd - candidate === runLength) {
        matched = candidateEnd;
        break;
      }
      closeStart = candidateEnd;
    }
    if (matched === -1) {
      output.push(convertMathInPlain(text.slice(tickStart)));
      break;
    }
    output.push(text.slice(tickStart, matched));
    index = matched;
  }
  return output.join('');
}

function convertMathInPlain(text: string): string {
  let result = text.replace(
    /\\\[((?:(?!\\\])[\s\S])*)\\\]/g,
    (_match, inner: string) => `\n\n$$\n${inner.trim()}\n$$\n\n`,
  );
  result = result.replace(
    /\$\$((?:(?!\$\$)[\s\S])*?\n(?:(?!\$\$)[\s\S])*?)\$\$/g,
    (match, inner: string) => {
      if (inner.startsWith('\n') && inner.endsWith('\n')) return match;
      return `\n\n$$\n${inner.trim()}\n$$\n\n`;
    },
  );
  return result.replace(
    /\\\(((?:(?!\\\))[^\n])*)\\\)/g,
    (_match, inner: string) => `$${inner}$`,
  );
}
