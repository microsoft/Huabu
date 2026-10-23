// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { type AgentIconValue } from '@/components/Common/AgentIcon';
import { Button } from '@/components/Common/Button';
import { DropdownMenu } from '@/components/Common/DropdownMenu';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import {
  AgentSelector,
  type AgentChoice,
} from '@/components/Panels/ChatPanel/AgentSelector';
import {
  SlashCommandMenu,
  type SlashCommandMenuRef,
} from '@/components/Panels/ChatPanel/SlashCommandMenu';
import { AgentIconPicker } from '@/components/Settings/agent-profiles/AgentIconPicker';

import type { AgentProfileView } from '@huabu/shared';

const profiles: AgentProfileView[] = [
  {
    id: 'reviewer',
    alias: 'Reviewer',
    agentletId: 'fixture',
    workingDirPath: '/fixture',
    launch: { kind: 'acp-command', command: 'fixture --acp' },
  },
  {
    id: 'long',
    alias: 'LongUnbrokenAgentName'.repeat(5),
    agentletId: 'fixture',
    workingDirPath: '/fixture',
    launch: { kind: 'acp-command', command: 'fixture --acp' },
  },
];

function PopoverStylesFixture() {
  const [agent, setAgent] = useState<AgentChoice>({
    binding: { kind: 'internal' },
    mode: 'ask',
  });
  const [icon, setIcon] = useState<AgentIconValue>({
    shape: 'diamond',
    color: 'blue',
  });
  const [result, setResult] = useState('');
  const [formValue, setFormValue] = useState('first');
  const commands = useRef<SlashCommandMenuRef>(null);

  return (
    <div className="flex flex-col items-start gap-4 p-4">
      <output data-popover-result>{result}</output>
      <div data-agent-sample className="max-w-full">
        <AgentSelector
          currentBinding={agent.binding}
          currentMode={agent.mode}
          profiles={profiles}
          editable
          onSelect={setAgent}
          onRefreshProfiles={() => undefined}
        />
      </div>
      <div data-icon-sample>
        <AgentIconPicker value={icon} onChange={setIcon} alias="Reviewer" />
      </div>
      <DropdownMenu
        trigger={<Button>Form sample</Button>}
        contentRole="dialog"
        className="w-72 p-3"
      >
        <label className="text-fg-muted mb-2 flex flex-col gap-1 text-xs">
          Link title
          <TextInput defaultValue="Example" />
        </label>
        <Select
          ariaLabel="Form selection"
          value={formValue}
          onChange={setFormValue}
          options={[
            { value: 'first', label: 'First value' },
            { value: 'second', label: 'Second value' },
          ]}
        />
      </DropdownMenu>
      <div className="relative mt-64 w-full max-w-80">
        <TextInput
          aria-label="Command input"
          defaultValue="/"
          className="w-full"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              commands.current?.moveHighlight(
                event.key === 'ArrowDown' ? 1 : -1,
              );
            }
          }}
        />
        <SlashCommandMenu
          ref={commands}
          filter=""
          commands={[
            {
              name: 'review',
              description: 'Review the current changes',
              input: { hint: 'file or folder' },
            },
            { name: 'explain', description: 'Explain the selected code' },
          ]}
          onSelect={(command) => setResult(command.name)}
        />
      </div>
    </div>
  );
}

export function mountPopoverStylesFixture() {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;background:var(--bg-default);z-index:9000;overflow:auto';
  document.body.append(host);
  createRoot(host).render(<PopoverStylesFixture />);
}
