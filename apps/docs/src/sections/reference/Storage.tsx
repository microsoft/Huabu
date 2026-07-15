// TODO: fill in real handbook content for this section.
import {
  Callout,
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
  { id: 'app-data', label: 'App-wide data' },
  { id: 'backup-and-migration', label: 'Backup & migration' },
  { id: 'hand-editing', label: 'Hand-editing files' },
];

export default function Storage() {
  return (
    <PageLayout
      title="Data Storage"
      description="Huabu stores data in two places: the Home folder you choose (per-Space data, backup-friendly) and an app-wide data folder (model credentials, machine-local). Everything is plain files — no opaque database."
      toc={toc}
    >
      <H2>Home layout</H2>
      <P>
        A Home is <strong>Space-self-contained</strong> — each Space is one
        directory holding everything related to it. A separate{' '}
        <Code>setting/</Code> folder holds Home-wide things (memory & skills).
      </P>
      <CodeBlock language="text">{`<home>/
├── <space-title>/                     # one folder per Space
│   ├── canvas.json                    # this Space's topology
│   ├── nodes/<node-title>.md
│   ├── .artifacts/<artifactId>.<ext>
│   ├── .memory/canvas.md              # Space memory (hidden)
│   └── .history/                      # conversation and event history
└── setting/
    ├── .huabu.md                      # User memory
    └── skills/<id>/SKILL.md           # user-authored skills`}</CodeBlock>
      <Callout tone="info">
        The on-disk names <Code>canvas.json</Code>,{' '}
        <Code>.memory/canvas.md</Code> and <Code>.huabu.md</Code> are kept from
        earlier versions for compatibility. Conceptually they are this
        Space&apos;s topology, its Space memory, and your User memory.
      </Callout>

      <H2>Per-Space files</H2>
      <Table
        headers={['Item', 'Format', 'Notes']}
        rows={[
          [
            <Code>canvas.json</Code>,
            'JSON (atomic writes)',
            'Topology — nodes, edges, geometry, version. Each save writes a .tmp then renames.',
          ],
          [
            <Code>nodes/&lt;title&gt;.md</Code>,
            'Markdown + YAML frontmatter',
            'One file per node (Note / Text / Web / PDF / Image / Video / Frame). Don&apos;t edit the id field.',
          ],
          [
            <Code>.artifacts/</Code>,
            'Raw binaries',
            'PDF / image / video originals; filename = artifactId, served at /api/canvas/<canvasId>/artifact/<artifactId>.<ext>.',
          ],
          [
            <Code>.memory/canvas.md</Code>,
            'Markdown',
            'Space-level memory the AI writes (hidden dir). Capped at ~4 KB on the next AI write.',
          ],
          [
            <Code>.history/</Code>,
            'JSON / JSONL',
            'Conversation threads and event timeline. Cleared on Space delete.',
          ],
        ]}
      />
      <Callout tone="info">
        Which nodes don&apos;t get a <Code>.md</Code>?{' '}
        <strong>Sketch and Question</strong> — they live entirely in{' '}
        <Code>canvas.json</Code>. Frame gets a frontmatter-only <Code>.md</Code>{' '}
        with no body.
      </Callout>

      <H2>Home settings & skills</H2>
      <Table
        headers={['File', 'Contents']}
        rows={[
          [
            <Code>setting/.huabu.md</Code>,
            'User memory — preferences and context that apply across every Space. Capped at ~4 KB.',
          ],
          [
            <Code>setting/skills/&lt;id&gt;/SKILL.md</Code>,
            'A user-authored skill. The folder may contain additional resource files referenced from the SKILL.md.',
          ],
        ]}
      />

      <H2>App-wide data</H2>
      <P>
        Beyond your Home, Huabu also keeps a small machine-local data folder for
        credentials. Treat it as private — do not commit it to a public
        repository.
      </P>
      <Table
        headers={['File', 'Contents']}
        rows={[
          [
            <Code>llm-config.json</Code>,
            'Currently selected provider / model / API key.',
          ],
          [
            <Code>oauth-credentials.json</Code>,
            'GitHub Copilot OAuth credentials (including refresh token; permissions 0600 where possible).',
          ],
        ]}
      />

      <H2>Backup & migration</H2>
      <P>
        Because a Home is a <strong>plain folder</strong>, backup and migration
        are straightforward:
      </P>
      <Table
        headers={['Scenario', 'How']}
        rows={[
          [
            'Routine local backup',
            'Copy the Home folder, or include it in your usual snapshot routine.',
          ],
          [
            'Cross-device sync',
            'iCloud / Dropbox / OneDrive / Syncthing — all work.',
          ],
          [
            'Version control',
            <>
              <Code>git init</Code> the Home; each save is a diff-able JSON
              change.
            </>,
          ],
          [
            'Switch Homes',
            'Pick a different folder in Settings; the old one stays untouched.',
          ],
          [
            'Share one Space',
            'Export to a .zip from the Space list; the recipient imports it.',
          ],
        ]}
      />
      <Callout tone="tip">
        Exported Space bundles include <Code>.artifacts/</Code>, so attachments
        come along for the ride — no separate file transfer needed.
      </Callout>

      <H2>Hand-editing files</H2>
      <Table
        headers={['File', 'Hand-editable?']}
        rows={[
          [
            <Code>canvas.json</Code>,
            'Not recommended — corruption is rejected on load. Back up first.',
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
            <Code>setting/.huabu.md</Code>,
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
