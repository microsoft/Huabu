// TODO: fill in real handbook content for this section.
import { H2, P, PageLayout, Table, type TocEntry } from '../../components';

const toc: TocEntry[] = [
  { id: 'supported-formats', label: 'Supported formats' },
  { id: 'creating', label: 'Creating' },
  { id: 'viewing', label: 'Viewing' },
  { id: 'sizing', label: 'Sizing' },
];

export default function ImageNode() {
  return (
    <PageLayout
      title="Image"
      description="Drop images on the canvas — Huabu auto-fits each node to the source aspect ratio and lets you zoom into it in the lightbox."
      toc={toc}
    >
      <H2>Supported formats</H2>
      <P>PNG, JPG, GIF, WebP and SVG. Animated GIFs play in-place.</P>

      <H2>Creating</H2>
      <Table
        headers={['Source', 'How']}
        rows={[
          ['Upload', 'Toolbar &gt; Image, then pick a file.'],
          ['Paste', 'Paste an image from the clipboard onto the canvas.'],
          ['Drag', 'Drag an image file from your OS file browser.'],
          ['URL', 'Paste a direct image URL.'],
          [
            'PDF screenshot',
            'In the PDF lightbox, take a rectangular screenshot of a page; it lands on the canvas as an Image node.',
          ],
        ]}
      />

      <H2>Viewing</H2>
      <P>
        Double-click an image to open the lightbox. The viewer supports pinch /
        scroll zoom and pan; press Escape (or click outside) to close.
      </P>

      <H2>Sizing</H2>
      <P>
        Image nodes start sized to the source aspect ratio. Drag a corner handle
        to resize while preserving aspect; drag a side handle to crop the
        rendered area.
      </P>
    </PageLayout>
  );
}
