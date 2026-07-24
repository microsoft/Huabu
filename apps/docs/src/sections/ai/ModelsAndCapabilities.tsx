// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Callout,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'choose-models', label: 'Choose your models' },
  { id: 'chat-model', label: 'Chat Model' },
  { id: 'utility-model', label: 'Utility Model' },
  { id: 'image-understanding', label: 'Image understanding' },
  { id: 'image-generation', label: 'Image generation' },
  { id: 'web-and-video', label: 'Web search and video transcripts' },
];

export default function ModelsAndCapabilities() {
  return (
    <PageLayout
      title="Models & Capabilities"
      description="Understand which model Huabu uses for each kind of work and configure optional web, image, and video capabilities."
      toc={toc}
    >
      <H2>Choose your models</H2>
      <P>
        Open <strong>Settings &gt; Huabu Agent</strong> to configure models and
        optional capabilities. <strong>Chat</strong> and <strong>Agent</strong>{' '}
        require a <strong>Provider</strong>, its credentials or sign-in, and a
        Chat Model or Azure OpenAI Deployment.
      </P>
      <Table
        headers={['Setting', 'Used for', 'Required']}
        rows={[
          [
            <strong>Chat Model or Deployment</strong>,
            'Conversations, Agent work, and running Skills.',
            'Yes',
          ],
          [
            <strong>Utility Model</strong>,
            'Memory, Skill creation and updates, labels, summaries, keywords, and intent suggestions.',
            'No',
          ],
          [
            <strong>Image Generation</strong>,
            'Creating or editing images through Agent.',
            'No',
          ],
        ]}
      />

      <H2>Chat Model</H2>
      <P>
        The <strong>Chat Model</strong> powers built-in Chat and Agent
        conversations. It reasons over your request, reads Space material,
        chooses tools, and plans Space changes. Running a <strong>Skill</strong>{' '}
        to complete a task also uses this model. Chat acts as the fallback when
        the <strong>Utility Model</strong> is not configured or cannot process
        required image input.
      </P>
      <P>
        When a Provider exposes multiple models, Settings labels the selection{' '}
        <strong>Default model</strong>. Built-in Chat and Agent conversations
        use it until you switch models above the chat input. The new choice is
        saved for that conversation only and does not change the Settings
        default. A Provider or account that exposes one model shows{' '}
        <strong>Model</strong> instead. <strong>Azure OpenAI</strong> uses the
        single <strong>Deployment</strong> configured in Settings, so there is
        no conversation-level model choice. Models with configurable reasoning
        also show a <strong>Reasoning</strong> control above the chat input.
      </P>
      <Callout tone="tip">
        For a multi-model Provider, keep a capable model with a sufficiently
        large context window as your <strong>Default model</strong>, then switch
        individual conversations when a task benefits from a different model.
      </Callout>

      <H2>Utility Model</H2>
      <P>
        The optional <strong>Utility Model</strong> handles frequent,
        lightweight background work: Memory curation, Skill creation and
        updates, intent suggestions, image and Frame labels, and content labels,
        summaries, and keywords. A faster or less expensive model can reduce
        latency and cost for these tasks.
      </P>
      <Callout tone="info">
        Leave Utility Model set to <strong>Automatic (cheapest)</strong> and
        Huabu selects the least expensive eligible model that it can confirm for
        your Chat Model provider. If availability cannot be confirmed, including
        with a <strong>Codex subscription login</strong>, Huabu uses the{' '}
        <strong>Chat Model</strong>. For predictable capability and cost, choose
        a specific Utility Model instead.
      </Callout>

      <H2>Image understanding</H2>
      <P>
        Chat and Agent can inspect images when the selected{' '}
        <strong>Chat Model</strong> supports image input. Huabu also uses image
        input when it labels image nodes or interprets visual context. If a
        configured <strong>Utility Model</strong> cannot accept images, Huabu
        falls back to the Chat Model for that image task.
      </P>

      <H2>Image generation</H2>
      <P>
        Image Generation is separate from the Chat and Utility Models. Configure
        an Azure OpenAI image deployment in{' '}
        <strong>Settings &gt; Huabu Agent</strong> to let Agent create images or
        use Space images and sketches as visual references. Built-in Chat is
        read-only and does not generate images in the Space.
      </P>

      <H2>Web search and video transcripts</H2>
      <Table
        headers={['Capability', 'What it enables', 'Setup']}
        rows={[
          [
            <strong>Web Search</strong>,
            'Lets Chat and Agent find current information and cite the source URLs.',
            'Add a Tavily API key under Settings > Huabu Agent > Other Capabilities.',
          ],
          [
            <strong>YouTube Transcripts</strong>,
            'Lets Huabu import transcript text when processing YouTube material.',
            'Add a RapidAPI key under Settings > Huabu Agent > Other Capabilities.',
          ],
        ]}
      />
      <Callout tone="info">
        Skills provide reusable instructions; they do not add new tools. Web
        search, image generation, and transcript loading must be configured as
        capabilities separately.
      </Callout>
    </PageLayout>
  );
}
