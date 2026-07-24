// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AgentNodeStatusGuide,
  ExternalAgentIconGuide,
  HuabuAgentIdentityGuide,
} from './AgentNodeStatusGuide';
import { H2, P, PageLayout, type TocEntry } from '../../components';

const toc: TocEntry[] = [
  { id: 'huabu-chat-and-huabu-agent', label: 'Huabu Chat and Huabu Agent' },
  {
    id: 'external-agent-profile-icons',
    label: 'External Agent Profile icons',
  },
  { id: 'read-agent-node-status', label: 'Read Agent Node status' },
];

export default function AgentsAndStatus() {
  return (
    <PageLayout
      title="Agents & Agent Node Status"
      description="Recognize Huabu Chat, Huabu Agent, External Agent Profile icons, and the status shown around an Agent Node."
      toc={toc}
    >
      <H2>Huabu Chat and Huabu Agent</H2>
      <P>
        Huabu Chat and Huabu Agent use distinct blue characters. Huabu Chat is a
        plain conversation; Huabu Agent can also act on your Space.
      </P>
      <HuabuAgentIdentityGuide />

      <H2>External Agent Profile icons</H2>
      <P>
        Profile icons help you recognize and distinguish External Agents at a
        glance, especially when several Agents are working in the same Space.
        Each External Agent uses its Profile icon in Agent menus and on Agent
        Nodes. Choose one of four shapes and four colors in Settings &gt;
        External Agents.
      </P>
      <ExternalAgentIconGuide />

      <H2>Read Agent Node status</H2>
      <P>
        The character or Profile icon identifies the Agent that owns the
        conversation. Its surrounding chrome shows whether the conversation is
        open, the Agent is running, or something needs your attention.
      </P>
      <AgentNodeStatusGuide />
      <P>
        Running rotates the status ring and an External Agent&apos;s shape. Done
        · unread, Error, and Changes skipped use a low-frequency attention
        nudge. Permission required pauses the Agent&apos;s working motion while
        a warning halo pulses around the static ring and shield until you
        respond. Opening a conversation replaces the ring with a speech bubble;
        Done · viewed returns to a quiet ring.
      </P>
      <P>
        The number on the Changes skipped badge counts how many of the
        Agent&apos;s edits Huabu skipped because you were editing the target
        node when the run finished, so a partly applied run is not reported as
        fully done.
      </P>
      <P>
        As you zoom out, the mark moves to the center and eventually stands in
        for the whole Agent Node. At the smallest size it becomes a colored dot,
        while keeping the same Agent identity and status meaning.
      </P>
    </PageLayout>
  );
}
