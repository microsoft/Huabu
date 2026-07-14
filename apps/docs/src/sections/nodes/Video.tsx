// TODO: fill in real handbook content for this section.
import { H2, P, PageLayout, Table, type TocEntry } from '../../components';

const toc: TocEntry[] = [
  { id: 'supported-sources', label: 'Supported sources' },
  { id: 'creating', label: 'Creating' },
  { id: 'viewing', label: 'Viewing' },
];

export default function VideoNode() {
  return (
    <PageLayout
      title="Video"
      description="Drop video files or paste a YouTube link — the node embeds the player directly on the Space."
      toc={toc}
    >
      <H2>Supported sources</H2>
      <P>
        MP4, WebM, MOV and OGG files; plus YouTube embeds via a pasted URL.
        File-based videos play inline using the browser&apos;s native player.
      </P>

      <H2>Creating</H2>
      <Table
        headers={['Source', 'How']}
        rows={[
          ['Upload', 'Toolbar &gt; Video, then pick a file.'],
          ['Paste', 'Paste a video file from the clipboard.'],
          ['URL', 'Paste a YouTube link or a direct video URL.'],
        ]}
      />

      <H2>Viewing</H2>
      <P>
        The node renders an inline player you can play / pause without
        expanding. Double-click to open the lightbox for a larger viewer with
        the same controls.
      </P>
    </PageLayout>
  );
}
