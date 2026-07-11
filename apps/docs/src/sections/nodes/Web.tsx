// TODO: fill in real handbook content for this section.
import {
  Callout,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'creating', label: 'Creating' },
  { id: 'extracted-article', label: 'Extracted article' },
  { id: 'toolbar', label: 'Toolbar' },
];

export default function WebNode() {
  return (
    <PageLayout
      title="Web"
      description="A Web node captures a URL. In the background Huabu extracts the article body so the AI can read it alongside your other notes."
      toc={toc}
    >
      <H2>Creating</H2>
      <Table
        headers={['Source', 'How']}
        rows={[
          ['Paste URL', 'Paste a link on an empty canvas spot.'],
          [
            'Link dialog',
            'Toolbar &gt; Web, then paste a URL into the dialog.',
          ],
        ]}
      />

      <H2>Extracted article</H2>
      <P>
        After the node is created Huabu fetches the page and extracts a Markdown
        version of the article body. Double-click the node to preview that
        extracted text in the lightbox.
      </P>
      <Callout tone="info">
        The extracted Markdown is what feeds the AI&apos;s context — see{' '}
        <DocLink href="/docs/nodes/content">Node Content</DocLink> for the
        wrapping rules.
      </Callout>

      <H2>Toolbar</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Open original URL</strong> — launch the page in a new tab.
        </li>
        <li>
          <strong>Expand</strong> — open the lightbox preview.
        </li>
      </ul>
    </PageLayout>
  );
}
