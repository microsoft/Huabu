// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Button } from '@/components/Common/Button';
import { MilkdownEditor } from '@/components/Milkdown/MilkdownEditor';
import { MilkdownFloatingToolbar } from '@/components/Milkdown/MilkdownFloatingToolbar';
import { AiSummaryButton } from '@/components/Nodes/AiSummaryButton';
import { ProvenanceOverlay } from '@/components/Nodes/note/ProvenanceOverlay';
import { SketchSizePicker } from '@/components/Nodes/sketch/SketchSizePicker';
import { AgentSelector } from '@/components/Panels/ChatPanel/AgentSelector';
import { ExpandedNodePanel } from '@/components/Panels/ExpandedNodePanel/ExpandedNodePanel';
import useCanvasStore from '@/store/canvasStore';

import type { MilkdownInstance } from '@/components/Milkdown/createMilkdown';

function PopoverBehaviorFixture({ longDiff = false }: { longDiff?: boolean }) {
  const [instance, setInstance] = useState<MilkdownInstance | null>(null);
  const [size, setSize] = useState(4);
  const [result, setResult] = useState('');
  const [reviewedBlock, setReviewedBlock] = useState(false);
  const [reviewedDeletion, setReviewedDeletion] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const key = instance?.snapshotBlocks().keys[0];
  const record = (action: string) => setResult(action);

  return (
    <div className="flex flex-col items-start gap-4 p-4">
      <output data-behavior-result>{result}</output>
      <Button onClick={() => record('outside')}>Outside action</Button>
      <Button onClick={() => setReviewedBlock(true)}>
        Remove block marker
      </Button>
      <div data-long-agents>
        <AgentSelector
          currentBinding={{ kind: 'internal' }}
          currentMode="ask"
          editable
          onSelect={(choice) =>
            record(
              choice.binding.kind === 'external'
                ? (choice.binding.alias ?? '')
                : 'internal',
            )
          }
          profiles={Array.from({ length: 35 }, (_, index) => ({
            id: `profile-${index}`,
            alias: `Agent ${index}`,
            agentletId: 'fixture',
            workingDirPath: '/fixture',
            launch: { kind: 'acp-command', command: 'fixture' },
          }))}
        />
      </div>
      <AiSummaryButton
        summary={'LongUnbrokenSummary'.repeat(30)}
        keywords={['LongUnbrokenKeyword'.repeat(15)]}
      />
      <SketchSizePicker
        label="Audit thickness"
        value={size}
        min={1}
        max={20}
        onChange={setSize}
      />
      <div ref={surface} className="relative mx-3 mt-24 w-[calc(100%-24px)]">
        <MilkdownFloatingToolbar instance={instance} surfaceRef={surface} />
        <MilkdownEditor
          markdown="A changed paragraph for keyboard review."
          onReady={setInstance}
        />
        {instance && key && (
          <ProvenanceOverlay
            editor={instance}
            containerRef={surface}
            blocks={
              reviewedBlock
                ? []
                : [
                    {
                      key,
                      baselineMarkdown: longDiff
                        ? 'Original paragraph. '.repeat(500)
                        : 'Original paragraph.',
                      at: '2026-01-01',
                    },
                  ]
            }
            tombstones={
              reviewedDeletion
                ? []
                : [
                    {
                      key: 'deleted-fixture',
                      baselineMarkdown: 'Deleted paragraph.',
                      anchorKey: key,
                      at: '2026-01-01',
                    },
                  ]
            }
            onAcceptBlock={() => {
              setReviewedBlock(true);
              record('accepted');
            }}
            onRejectBlock={() => {
              setReviewedBlock(true);
              record('rejected');
            }}
            onRestoreTombstone={() => {
              setReviewedDeletion(true);
              record('restored');
            }}
            onDismissTombstone={() => {
              setReviewedDeletion(true);
              record('dismissed');
            }}
          />
        )}
      </div>
    </div>
  );
}

export function mountPopoverBehaviorFixture(longDiff = false) {
  const app = document.getElementById('root');
  if (app) app.style.visibility = 'hidden';
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;z-index:10;background:var(--bg-default);overflow:auto';
  document.body.append(host);
  createRoot(host).render(<PopoverBehaviorFixture longDiff={longDiff} />);
}

export function mountConnectedNodeFixture() {
  const node = (id: string) => ({
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { label: id, content: id },
  });
  const sources = Array.from({ length: 40 }, (_, i) => node(`Source ${i}`));
  const destinations = [node('Destination 0'), node('Destination 1')];
  useCanvasStore.setState({ isLoading: true });
  useCanvasStore.setState({
    isLoading: false,
    canvasId: 'review-fixture',
    nodes: [node('Target'), ...sources, ...destinations],
    edges: [
      ...sources.map(({ id }) => ({
        id,
        source: id,
        target: 'Target',
        data: { edgeStyle: { direction: 'forward' as const } },
      })),
      ...destinations.map(({ id }) => ({
        id,
        source: 'Target',
        target: id,
        data: { edgeStyle: { direction: 'forward' as const } },
      })),
    ],
  });
  const app = document.getElementById('root');
  if (app) app.style.display = 'none';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:var(--bg-surface)';
  document.body.append(host);
  createRoot(host).render(<ExpandedNodePanel nodeId="Target" embedded />);
}
