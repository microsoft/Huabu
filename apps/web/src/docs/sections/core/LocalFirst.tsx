import {
  Callout,
  Code,
  CodeBlock,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'why-files', label: 'Why files, not a database' },
  { id: 'layout', label: 'Anatomy of a workspace folder' },
  { id: 'markdown-first', label: 'Markdown-first content' },
  { id: 'sync-and-backup', label: 'Sync, backup & version control' },
  { id: 'interop', label: 'Playing well with other tools' },
];

export default function LocalFirst() {
  return (
    <PageLayout
      title="Local-first & Markdown"
      description="Huabu doesn't have a server-side database. Everything you create — canvases, notes, attachments, AI history, memory, skills — is a regular file inside a folder you chose. That choice shapes how the product feels."
      toc={toc}
    >
      <H2>Why files, not a database</H2>
      <P>Treating the workspace as a plain folder buys three properties:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>You own the data.</strong> No export step, no proprietary
          format. If Huabu disappeared tomorrow your notes would still be
          Markdown files.
        </li>
        <li>
          <strong>Standard tools just work.</strong> Time Machine, iCloud,
          Dropbox, Syncthing, Git, ripgrep, your favourite text editor — all of
          them treat a Huabu workspace like any other folder.
        </li>
        <li>
          <strong>The AI reads the same files you do.</strong> When the AI looks
          at a note it&apos;s reading exactly what&apos;s on disk, with no
          schema in between.
        </li>
      </ul>

      <H2>Anatomy of a workspace folder</H2>
      <CodeBlock language="text">{`<workspace>/
├── <canvas-title>/          one folder per canvas
│   ├── canvas.json          topology (nodes, edges, version)
│   ├── nodes/               one Markdown file per node
│   ├── .artifacts/          hidden: raw binaries (PDFs, images, videos)
│   ├── memory/canvas.md     AI-written canvas memory
│   └── .history/            hidden: chat + intent history
└── setting/
    ├── .huabu.md            workspace-wide memory
    └── skills/              reusable AI recipes (one folder each)`}</CodeBlock>
      <P>A few things worth noticing in this layout:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <Code>canvas.json</Code> is small — it stores node positions and
          edges, not content. Diffs stay readable.
        </li>
        <li>
          Node bodies live as one <Code>.md</Code> per node under{' '}
          <Code>nodes/</Code>, so the unit of change is the unit you actually
          care about.
        </li>
        <li>
          Heavy binaries are tucked under hidden <Code>.artifacts/</Code> so
          editors and search tools don&apos;t trip over them.
        </li>
        <li>
          Workspace-wide memory and skills sit beside the canvases, not inside
          any one of them.
        </li>
      </ul>
      <P>
        Full reference:{' '}
        <DocLink href="/docs/reference/storage">Data Storage</DocLink>.
      </P>

      <H2>Markdown-first content</H2>
      <P>
        Wherever Huabu can use Markdown, it does. Note bodies, AI replies,
        memory, skills and even extracted text from PDFs and web pages all end
        up as Markdown on disk. The benefit is twofold:
      </P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          You can open any node in your editor of choice and edit it; Huabu will
          pick up the change next time the canvas loads.
        </li>
        <li>
          Migrating to another tool is just copying files. There is no
          proprietary export format because there is no proprietary content
          format.
        </li>
      </ol>

      <H2>Sync, backup &amp; version control</H2>
      <Table
        headers={['Tool', 'How to use it']}
        rows={[
          [
            <strong>Time Machine / Restic / rsync</strong>,
            'Point your backup at the workspace folder. No special setup.',
          ],
          [
            <strong>iCloud / Dropbox / OneDrive / Syncthing</strong>,
            'Put the workspace inside the synced folder. Avoid editing the same canvas on two machines at once (no real-time merge).',
          ],
          [
            <strong>Git</strong>,
            <>
              <Code>git init</Code> the workspace, commit
              <Code>canvas.json</Code> and <Code>nodes/**</Code>, ignore{' '}
              <Code>.artifacts/</Code> and <Code>.history/</Code> if you
              don&apos;t want the binaries / chat logs in history.
            </>,
          ],
        ]}
      />
      <Callout tone="warning">
        Huabu is single-machine today. If two clients open the same canvas at
        the same time the second writer wins. Real-time multi-user collaboration
        isn&apos;t implemented yet.
      </Callout>

      <H2>Playing well with other tools</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Obsidian / iA Writer / Typora</strong> can edit any node file
          directly. Watch out for frontmatter — Huabu may add a few keys on its
          next save.
        </li>
        <li>
          <strong>ripgrep / fzf</strong> work over the whole workspace, so
          full-text search across canvases is one shell command away.
        </li>
        <li>
          <strong>Static-site generators</strong> can publish the{' '}
          <Code>nodes/</Code> folder of a canvas as a website without extracting
          from a database.
        </li>
      </ul>
    </PageLayout>
  );
}
