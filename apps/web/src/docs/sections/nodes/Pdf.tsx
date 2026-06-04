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
  { id: 'viewing', label: 'Viewing' },
  { id: 'selection-mode', label: 'Selection mode' },
  { id: 'toolbar', label: 'Toolbar' },
];

export default function PdfNode() {
  return (
    <PageLayout
      title="PDF"
      description="PDFs live on the canvas as full documents. The lightbox viewer offers page thumbnails, download, and a selection mode that drags text or screenshots back onto the canvas."
      toc={toc}
    >
      <H2>Creating</H2>
      <Table
        headers={['Source', 'How']}
        rows={[
          ['Upload', 'Toolbar &gt; PDF, then pick a file.'],
          ['Paste', 'Paste a PDF from the clipboard.'],
          ['URL', 'Paste a direct PDF URL.'],
        ]}
      />

      <H2>Viewing</H2>
      <P>
        Double-click the node to open the PDF lightbox. The left rail shows page
        thumbnails; the main viewer renders pages as you scroll.
      </P>

      <H2>Selection mode</H2>
      <P>
        Switch the viewer into <em>selection mode</em> to either:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Drag a text selection onto the canvas — it lands as a Note containing
          the copied text.
        </li>
        <li>
          Drag a rectangular region — it lands as an Image node (a screenshot of
          that region).
        </li>
      </ul>
      <Callout tone="tip">
        Either way the new node keeps an invisible semantic edge back to the PDF
        so auto-layout keeps them together. See{' '}
        <DocLink href="/docs/ai/intent">Intent &amp; Auto-layout</DocLink>.
      </Callout>

      <H2>Toolbar</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Expand</strong> — open the lightbox viewer.
        </li>
        <li>
          <strong>Download</strong> — save the original PDF.
        </li>
        <li>
          <strong>Set / clear cover</strong> — choose a page thumbnail to use as
          the node&apos;s visible preview.
        </li>
      </ul>
    </PageLayout>
  );
}
