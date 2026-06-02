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
  { id: 'workspace-layout', label: 'Workspace layout' },
  { id: 'per-canvas-files', label: 'Per-canvas files' },
  { id: 'workspace-settings', label: 'Workspace settings & skills' },
  { id: 'app-data', label: 'App-wide data' },
  { id: 'backup-and-migration', label: 'Backup & migration' },
  { id: 'hand-editing', label: 'Hand-editing files' },
];

export default function Storage() {
  return (
    <PageLayout
      title="Data Storage"
      description="Huabu stores data in two places: the workspace folder you choose (per-canvas data, backup-friendly) and an app-wide data folder (model credentials, machine-local). Everything is plain files — no opaque database."
      toc={toc}
    >
      <H2>Workspace layout</H2>
      <P>
        A workspace is <strong>canvas-self-contained</strong> — each canvas is
        one directory holding everything related to it. A separate{' '}
        <Code>setting/</Code> folder holds workspace-wide things (memory &
        skills).
      </P>
      <CodeBlock language="text">{`<workspace>/
├── <canvas-title>/                    # one folder per canvas
│   ├── canvas.json
│   ├── nodes/<node-title>.md
│   ├── .artifacts/<artifactId>.<ext>
│   ├── memory/canvas.md
│   └── .history/{chat/<threadId>.json, intent.json, events.json}
└── setting/
    ├── .huabu.md                      # workspace memory
    └── skills/<id>/SKILL.md           # user-authored skills`}</CodeBlock>

      <H2>Per-canvas files</H2>
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
            <Code>memory/canvas.md</Code>,
            'Markdown',
            'Canvas-level memory the AI writes. Capped at ~4 KB on the next AI write.',
          ],
          [
            <Code>.history/</Code>,
            'JSON',
            'Chat threads, intent log, event timeline. Cleared on canvas delete.',
          ],
        ]}
      />
      <Callout tone="info">
        Which nodes don&apos;t get a <Code>.md</Code>?{' '}
        <strong>Sketch and Question</strong> — they live entirely in{' '}
        <Code>canvas.json</Code>. Frame gets a frontmatter-only <Code>.md</Code>{' '}
        with no body.
      </Callout>

      <H2>Workspace settings & skills</H2>
      <Table
        headers={['File', 'Contents']}
        rows={[
          [
            <Code>setting/.huabu.md</Code>,
            'Workspace-wide memory — preferences and context that apply across every canvas. Capped at ~4 KB.',
          ],
          [
            <Code>setting/skills/&lt;id&gt;/SKILL.md</Code>,
            'A user-authored skill. The folder may contain additional resource files referenced from the SKILL.md.',
          ],
        ]}
      />

      <H2>App-wide data</H2>
      <P>
        Beyond your workspace, Huabu also keeps a small machine-local data
        folder for credentials. Treat it as private — do not commit it to a
        public repository.
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
        Because a workspace is a <strong>plain folder</strong>, backup and
        migration are straightforward:
      </P>
      <Table
        headers={['Scenario', 'How']}
        rows={[
          [
            'Routine local backup',
            'Copy the workspace folder, or include it in your usual snapshot routine.',
          ],
          [
            'Cross-device sync',
            'iCloud / Dropbox / OneDrive / Syncthing — all work.',
          ],
          [
            'Version control',
            <>
              <Code>git init</Code> the workspace; each save is a diff-able JSON
              change.
            </>,
          ],
          [
            'Switch workspaces',
            'Pick a different folder in Settings; the old one stays untouched.',
          ],
          [
            'Share one canvas',
            'Export to a .zip from the canvas list; the recipient imports it.',
          ],
        ]}
      />
      <Callout tone="tip">
        Exported canvas bundles include <Code>.artifacts/</Code>, so attachments
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
            '✅ Yes — next canvas load picks it up.',
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
            'Not recommended — but deletions only lose conversation context, not canvas content.',
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
