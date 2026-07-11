import { FileText, FolderTree, GitBranch, Save } from 'lucide-react';

import {
  Callout,
  CardGrid,
  Code,
  CodeBlock,
  H2,
  NavCard,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'the-promise', label: 'The promise: your folder, your data' },
  { id: 'why-files', label: 'Why files, not a database' },
  { id: 'why-markdown', label: 'Why Markdown specifically' },
  { id: 'layout', label: 'Anatomy of a workspace folder' },
  { id: 'sub-features', label: 'Sub-features built on the file model' },
  { id: 'sync-and-backup', label: 'Sync, backup & version control' },
  { id: 'interop', label: 'Interop with other tools' },
];

export default function OpenVault() {
  return (
    <PageLayout
      title="Open Vault"
      description="There is no server-side database. Every canvas, note, attachment, AI history file, memory entry and skill is a plain file inside a folder you chose — an open vault you can back up, sync, version-control or edit with any other tool. That single architectural decision shapes how the product feels."
      toc={toc}
    >
      <H2>The promise: your folder, your data</H2>
      <P>
        When you open a workspace you point Huabu at any folder on disk. From
        that moment on, every change you make — drawing a node, asking the AI a
        question, saving a skill — lands somewhere inside that folder as a plain
        file. There is no hidden database, no cloud copy, no export step. If
        Huabu disappeared tomorrow your work would still open in any text
        editor.
      </P>

      <H2>Why files, not a database</H2>
      <Table
        headers={['Property', 'What it buys you']}
        rows={[
          [
            <strong>Standard tools just work</strong>,
            'Time Machine, iCloud, Dropbox, Syncthing, Git, ripgrep — they all treat a Huabu workspace like any other folder.',
          ],
          [
            <strong>Human-readable diffs</strong>,
            'Reviewing what changed between two sessions is a git diff, not a SQL query.',
          ],
          [
            <strong>The AI reads the same files you do</strong>,
            'No schema sits between the model and your notes. Less to go wrong.',
          ],
          [
            <strong>Trivial migration</strong>,
            'Moving to another tool is copying files. There is no proprietary export format because there is no proprietary content format.',
          ],
        ]}
      />

      <H2>Why Markdown specifically</H2>
      <P>
        Wherever Huabu can use Markdown, it does — Note bodies, AI replies,
        memory, skills, even extracted text from PDFs and web pages. Markdown is
        structured enough for the AI to understand (headings, lists, links, code
        blocks) and simple enough for you to edit anywhere. The canonical
        alternative would be a custom rich-text format; we picked the format
        every editor on your machine already speaks.
      </P>

      <H2>Anatomy of a workspace folder</H2>
      <CodeBlock language="text">{`<workspace>/
├── <canvas-title>/          one folder per canvas
│   ├── canvas.json          topology (nodes, edges, version)
│   ├── nodes/               one Markdown file per node
│   ├── .artifacts/          hidden: raw binaries (PDFs, images, videos)
│   ├── .memory/canvas.md    AI-written canvas memory
│   └── .history/            hidden: chat + intent history
└── setting/
    ├── .huabu.md            workspace-wide memory
    └── skills/              reusable AI recipes (one folder each)`}</CodeBlock>
      <P>Three things worth calling out in this layout:</P>
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
      </ul>

      <H2>Sub-features built on the file model</H2>
      <CardGrid>
        <NavCard
          to="/docs/concepts/workspaces"
          icon={FolderTree}
          eyebrow="Container"
          title="Workspaces"
          description="Switching, recents, lifecycle of a canvas, import/export of canvas bundles."
        />
        <NavCard
          to="/docs/reference/storage"
          icon={Save}
          eyebrow="Reference"
          title="Data Storage"
          description="Exhaustive on-disk reference: every file Huabu writes, when, and why."
        />
        <NavCard
          to="/docs/nodes/content"
          icon={FileText}
          eyebrow="Nodes"
          title="Node Content"
          description="How node bodies are stored as Markdown the AI can read by tool call."
        />
        <NavCard
          to="/docs/ai/memory"
          icon={GitBranch}
          eyebrow="AI"
          title="Memory"
          description="Workspace + canvas memory tiers, both as hand-editable Markdown."
        />
      </CardGrid>

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
            'Put the workspace inside the synced folder. Avoid editing the same canvas on two machines at once (no real-time merge yet).',
          ],
          [
            <strong>Git</strong>,
            <>
              <Code>git init</Code> the workspace, commit{' '}
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

      <H2>Interop with other tools</H2>
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
