// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Code,
  CodeBlock,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'home-layout', label: 'Home layout' },
  { id: 'per-space-files', label: 'Per-Space files' },
  { id: 'home-settings', label: 'Home settings & skills' },
  { id: 'hand-editing', label: 'Hand-editing files' },
];

export default function DataAndBackup() {
  return (
    <PageLayout
      title="Data & Files"
      description="Huabu stores each Space as a directory of plain files inside the Home folder you choose."
      toc={toc}
    >
      <H2>Home layout</H2>
      <P>
        Each Space is a self-contained directory inside your Home. Its content,
        attachments, AI memory, and conversation history stay together.
      </P>
      <CodeBlock language="text">{`<home>/
├── <space-title>/                     # one folder per Space
│   ├── space.json                     # this Space's topology
│   ├── nodes/<node-title>.md
│   ├── .artifacts/<artifactId>.<ext>
│   ├── .memory/space.md              # Space memory
│   └── .history/                      # conversation and event history
└── setting/
    ├── user.md                        # User memory
    └── skills/<id>/SKILL.md           # user-authored skills`}</CodeBlock>

      <H2>Per-Space files</H2>
      <Table
        headers={['Item', 'Format', 'Notes']}
        rows={[
          [
            <Code>space.json</Code>,
            'JSON (atomic writes)',
            'Topology — nodes, edges, geometry, version. Each save writes a .tmp then renames.',
          ],
          [
            <Code>nodes/&lt;title&gt;.md</Code>,
            'Markdown + YAML frontmatter',
            "One file per node (Note / Text / Web / PDF / Image / Video / Frame). Don't edit the id field.",
          ],
          [
            <Code>.artifacts/</Code>,
            'Raw binaries',
            'PDF / image / video originals; each filename is based on its artifact ID.',
          ],
          [
            <Code>.memory/space.md</Code>,
            'Markdown',
            'Space-level memory the AI writes.',
          ],
          [
            <Code>.history/</Code>,
            'JSON / JSONL',
            'Conversation threads and event timeline.',
          ],
        ]}
      />

      <H2>Home settings & skills</H2>
      <P>
        The <Code>setting/</Code> directory contains information shared across
        Spaces: <Code>user.md</Code> stores user memory, while{' '}
        <Code>skills/&lt;id&gt;/SKILL.md</Code> stores user-authored skills and
        their supporting files.
      </P>

      <H2>Hand-editing files</H2>
      <Table
        headers={['File', 'Hand-editable?']}
        rows={[
          [
            <Code>space.json</Code>,
            "❌ Don't edit — Huabu manages this file automatically.",
          ],
          [
            <>
              <Code>nodes/&lt;title&gt;.md</Code> body
            </>,
            '✅ Yes — next Space load picks it up.',
          ],
          [
            <>
              <Code>nodes/&lt;title&gt;.md</Code> frontmatter <Code>id</Code>
            </>,
            '❌ Never — node references rely on it.',
          ],
          [
            <>
              <Code>nodes/&lt;title&gt;.md</Code> filename
            </>,
            '✅ Renaming the file renames the node on next load.',
          ],
          [
            <>
              <Code>.artifacts/</Code> filenames
            </>,
            <>
              ❌ Don&apos;t change — filename = artifactId, used by the
              node&apos;s <Code>src</Code>.
            </>,
          ],
          [
            <Code>.history/.../*.json</Code>,
            'Not recommended — but deletions only lose conversation context, not Space content.',
          ],
          [
            <Code>setting/user.md</Code>,
            '✅ Edit freely; the AI will respect the 4 KB cap on its next write.',
          ],
          [
            <Code>setting/skills/&lt;id&gt;/SKILL.md</Code>,
            '✅ Author your own skills here.',
          ],
        ]}
      />
    </PageLayout>
  );
}
