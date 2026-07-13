// TODO: fill in real handbook content for this section.
import { H2, P, PageLayout, Table, type TocEntry } from '../../components';

const toc: TocEntry[] = [
  { id: 'what-a-text-is', label: 'What a Text node is' },
  { id: 'creating', label: 'Creating' },
  { id: 'editing', label: 'Editing' },
  { id: 'toolbar', label: 'Toolbar' },
];

export default function TextNode() {
  return (
    <PageLayout
      title="Text"
      description="Text nodes hold short plain strings — titles, labels, captions — and expose typography controls instead of a block editor."
      toc={toc}
    >
      <H2>What a Text node is</H2>
      <P>
        Use Text where a Note would be overkill: a one-line section header above
        a Frame, a caption under an image, a tag next to a group. The body is a
        single styled string, not Markdown.
      </P>

      <H2>Creating</H2>
      <Table
        headers={['Source', 'How']}
        rows={[
          ['Toolbar', 'Pick Text from the Space toolbar.'],
          ['Paste', 'Paste a short string on an empty Space spot.'],
        ]}
      />

      <H2>Editing</H2>
      <P>
        Text edits in place — no lightbox. Click to focus, type, click out to
        commit. The node fits its content automatically.
      </P>

      <H2>Toolbar</H2>
      <P>The single-select toolbar exposes typography controls:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>Font family and size.</li>
        <li>Bold / italic / underline / strike-through.</li>
        <li>Text colour and background colour.</li>
      </ul>
    </PageLayout>
  );
}
