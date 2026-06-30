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
  { id: 'what-an-office-node-is', label: 'What an Office node is' },
  { id: 'creating', label: 'Creating' },
  { id: 'viewing', label: 'Viewing' },
  { id: 'toolbar', label: 'Toolbar' },
];

export default function OfficeNode() {
  return (
    <PageLayout
      title="Office"
      description="Word, Excel, and PowerPoint files live on the canvas as view-only cards. Huabu extracts their text for the AI; you download the original to edit it."
      toc={toc}
    >
      <H2>What an Office node is</H2>
      <P>
        Office nodes hold <code>.docx</code>, <code>.xlsx</code>, and{' '}
        <code>.pptx</code> files — modern OOXML formats only. Legacy{' '}
        <code>.doc</code> / <code>.xls</code> / <code>.ppt</code> are not
        supported. The card is text-only: it shows a format-specific icon (Word
        / Excel / PowerPoint) with the extension and an AI-generated summary.
      </P>

      <H2>Creating</H2>
      <Table
        headers={['Source', 'How']}
        rows={[
          ['Upload', 'Drag a file onto the canvas.'],
          ['Paste', 'Paste an Office file from the clipboard.'],
        ]}
      />

      <H2>Viewing</H2>
      <P>
        Double-click to open the large view. The body is extracted as plain text
        / Markdown — Excel sheets and PowerPoint slide text included — so the AI
        can search and cite it. Formatting, layout, and images are deliberately
        dropped.
      </P>
      <Callout tone="info">
        To see the original formatting, use the toolbar Download and open the
        file in your local Office / Keynote / WPS — these nodes are view-only.
      </Callout>

      <H2>Toolbar</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Expand</strong> — open the large text preview.
        </li>
        <li>
          <strong>Download</strong> — save the original file.
        </li>
      </ul>
      <Callout tone="info">
        See <DocLink href="/docs/nodes/content">Node Content</DocLink> for how
        the extracted text is ingested into the context Huabu sends to the AI.
      </Callout>
    </PageLayout>
  );
}
