/**
 * Tests for the preprocessor's pure wire-format encoder.
 *
 * The LLM-driven `prepareExternalAgentPrompt` and the private
 * `parsePromptJson` / `loadNodeBody` helpers are exercised end-to-end
 * via integration testing; here we just lock the on-the-wire shape of
 * `serializePrompt` so the format the external agent sees can't
 * regress silently.
 */

import { describe, expect, it } from 'vitest';

import { ACP_CANVAS_VFS_PREFIX } from './capabilities/fs.js';
import { serializePrompt } from './preprocessor.js';

import type { ExternalAgentPrompt } from '@sediment/shared';

describe('serializePrompt', () => {
  it('emits task-only output when there are no attachments', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Explain the difference between async iterators and generators.',
      attachments: [],
    };

    const out = serializePrompt(prompt);

    expect(out).toBe(
      'Explain the difference between async iterators and generators.',
    );
  });

  it('renders attachments as absolute paths when canvasRoot is supplied', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Review the attached code for race conditions.',
      attachments: [
        {
          path: 'nodes/server-loop.md',
          reason: 'user asks to review this code',
        },
      ],
    };

    const out = serializePrompt(prompt, {
      canvasRoot: '/data/canvases/abc',
    });

    expect(out).toContain('Review the attached code for race conditions.');
    expect(out).toContain('## Attachments');
    expect(out).toContain(
      '- `/data/canvases/abc/nodes/server-loop.md` — user asks to review this code',
    );
  });

  it('falls back to /canvas/ virtual prefix when canvasRoot is missing', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'Summarise the log.',
      attachments: [{ path: '.artifacts/run.log', reason: '20 KB log file' }],
    };

    const out = serializePrompt(prompt);

    expect(out).toContain(
      `- \`${ACP_CANVAS_VFS_PREFIX}.artifacts/run.log\` — 20 KB log file`,
    );
  });

  it('includes the "read each file" lead-in when attachments are present', () => {
    const prompt: ExternalAgentPrompt = {
      task: 'task',
      attachments: [
        { path: 'nodes/a.md', reason: 'r1' },
        { path: 'nodes/b.md', reason: 'r2' },
      ],
    };

    const out = serializePrompt(prompt, { canvasRoot: '/c' });

    expect(out).toContain(
      'Read each file below before answering — they were attached because verbatim content is required:',
    );
    // Each attachment renders on its own line with its reason.
    expect(out).toContain('- `/c/nodes/a.md` — r1');
    expect(out).toContain('- `/c/nodes/b.md` — r2');
  });
});
