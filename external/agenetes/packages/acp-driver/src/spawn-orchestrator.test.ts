import { AgentletRequestError } from '@agenetes/agentlet-host';
import { describe, expect, it } from 'vitest';

import { isSessionResumeUnavailableError } from './spawn-orchestrator.js';

describe('agentlet resume error classification', () => {
  it('accepts only the structured agentlet code', () => {
    expect(
      isSessionResumeUnavailableError(
        new AgentletRequestError({
          code: -32000,
          message: 'bootstrap failed',
          data: { code: 'session_resume_unavailable' },
        }),
      ),
    ).toBe(true);
    expect(
      isSessionResumeUnavailableError(
        new AgentletRequestError({
          code: -32000,
          message: 'bootstrap failed',
        }),
      ),
    ).toBe(false);
    expect(
      isSessionResumeUnavailableError(new Error('session_resume_unavailable')),
    ).toBe(false);
  });
});
