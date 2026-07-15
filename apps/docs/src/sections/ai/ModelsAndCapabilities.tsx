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
        optional capabilities. Only the Chat Model is required.
      </P>
      <Table
        headers={['Setting', 'Used for', 'Required']}
        rows={[
          [
            <strong>Chat Model</strong>,
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
        The Chat Model powers built-in Chat and Agent conversations. It reasons
        over your request, reads Space material, chooses tools, and plans Space
        changes. Running a Skill to complete a task also uses this model. Chat
        acts as the fallback when the Utility Model is not configured or cannot
        process required image input.
      </P>
      <Callout tone="tip">
        Choose the most capable model you want to use for interactive work. It
        needs a sufficiently large context window for longer conversations and
        Spaces.
      </Callout>

      <H2>Utility Model</H2>
      <P>
        The optional Utility Model handles frequent, lightweight background
        work: Memory curation, Skill creation and updates, intent suggestions,
        image and Frame labels, and content labels, summaries, and keywords. A
        faster or less expensive model can reduce latency and cost for these
        tasks.
      </P>
      <Callout tone="info">
        Leave Utility Model set to <strong>Follow chat model</strong> to use the
        Chat Model for these tasks too.
      </Callout>

      <H2>Image understanding</H2>
      <P>
        Chat and Agent can inspect images when the selected Chat Model supports
        image input. Huabu also uses image input when it labels image nodes or
        interprets visual context. If a configured Utility Model cannot accept
        images, Huabu falls back to the Chat Model for that image task.
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
