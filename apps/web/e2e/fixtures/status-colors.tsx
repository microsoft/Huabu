// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createRoot } from 'react-dom/client';

import { Button } from '@/components/Common/Button';
import { TextInput } from '@/components/Common/TextInput';
import { StatusMessage } from '@/components/Messages/StatusMessage';
import { InstructionFrameBadge } from '@/components/Nodes/frame/InstructionFrameBadge';
import { NodeRef } from '@/components/Nodes/NodeRef/NodeRef';
import { QuestionConversationCard } from '@/components/Nodes/question/QuestionConversationCard';
import { SpaceAgentActivity } from '@/components/Nodes/spacePreview/SpaceAgentActivity';
import { AgentletHealthBanner } from '@/components/Settings/agent-profiles/AgentletHealthBanner';

import '@/components/Nodes/question/QuestionNode.css';

const tones = ['success', 'warning', 'danger'] as const;
const states = [
  { tone: 'success', question: 'done', space: 'unread' },
  { tone: 'warning', question: 'approval', space: 'approval' },
  { tone: 'danger', question: 'error', space: 'error' },
] as const;

export function mountStatusColorsFixture() {
  const host = document.createElement('div');
  host.dataset.statusFixture = '';
  host.className =
    'bg-surface text-fg-default fixed inset-0 z-9000 overflow-auto p-4';
  document.body.append(host);
  createRoot(host).render(
    <>
      <h1 className="mb-4 text-xl">Status colors</h1>
      <div className="flex flex-wrap gap-4">
        {tones.map((tone) => (
          <div key={tone} className="flex flex-col gap-2">
            {(['solid', 'outline', 'ghost'] as const).map((variant) => (
              <Button key={variant} tone={tone} variant={variant}>
                {`${tone} ${variant}`}
              </Button>
            ))}
            <Button tone={tone} disabled>{`${tone} disabled`}</Button>
          </div>
        ))}
      </div>
      <div className="my-4 flex flex-wrap gap-4">
        {states.map(({ tone, question, space }) => (
          <div
            key={tone}
            className="w-80 max-w-full space-y-3"
            data-status-tone={tone}
          >
            <div className={`question-compact question-tone-${tone}`}>
              <QuestionConversationCard
                agent={{ kind: 'internal', alias: 'Huabu', mode: 'operate' }}
                status={question}
                unread
                conflictCount={0}
                text={`${tone} Agent`}
                placeholder=""
                effectiveWidth={320}
                effectiveHeight={130}
                effectiveFontSize={24}
                paddingX={16}
                paddingY={16}
              />
            </div>
            <div className="h-8">
              <SpaceAgentActivity
                activity={[
                  {
                    nodeId: `node-${tone}`,
                    threadId: `thread-${tone}`,
                    title: `${tone} conversation`,
                    status: space,
                  },
                ]}
                onOpen={() => {}}
              />
            </div>
          </div>
        ))}
      </div>
      <StatusMessage
        status="error"
        detail="Could not save changes."
        onRetry={() => {}}
      />
      <div className="my-4" data-secondary-copy>
        <h2 className="mb-3 text-base">
          P2: Retry countdown and active reference
        </h2>
        <AgentletHealthBanner
          agentlet={{ online: false, nextRestartAt: Date.now() + 60000 }}
          restarting={false}
          onRestart={async () => {}}
        />
        <NodeRef fallbackLabel="Readable reference" />
        <h2 className="mt-6 mb-3 text-base">P3: Neutral Question status</h2>
        <div className="question-compact w-80 max-w-full">
          <QuestionConversationCard
            agent={{ kind: 'internal', alias: 'Huabu', mode: 'operate' }}
            status="idle"
            unread={false}
            conflictCount={0}
            text="Plan the next step"
            placeholder=""
            effectiveWidth={320}
            effectiveHeight={130}
            effectiveFontSize={24}
            paddingX={16}
            paddingY={16}
          />
        </div>
      </div>
      <div className="my-4 flex items-center gap-4">
        <TextInput
          aria-label="Invalid field"
          aria-invalid
          defaultValue="Invalid value"
        />
        <InstructionFrameBadge
          kind="skill"
          titleFontSize={36}
          directAgentCount={0}
        />
      </div>
    </>,
  );
}
