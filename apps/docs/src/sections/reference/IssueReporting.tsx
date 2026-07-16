// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  { id: 'before-reporting', label: 'Before reporting' },
  { id: 'describe-the-problem', label: 'Describe the problem' },
  { id: 'system-information', label: 'System information' },
  { id: 'screenshots-and-logs', label: 'Screenshots and logs' },
  { id: 'ai-problems', label: 'AI-related problems' },
  { id: 'submit-the-issue', label: 'Submit the issue' },
];

export default function IssueReporting() {
  return (
    <PageLayout
      title="Report an Issue"
      description="Report bugs and unexpected behavior through GitHub Issues. A short report with clear reproduction steps gives the team the best chance of identifying and fixing the problem."
      toc={toc}
    >
      <Callout tone="info">
        Huabu uses{' '}
        <DocLink href="https://github.com/microsoft/Huabu/issues">
          GitHub Issues
        </DocLink>{' '}
        as its public feedback channel. Never include API keys, access tokens,
        private documents, or other sensitive data in an issue.
      </Callout>

      <H2>Before reporting</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Update Huabu</strong> to the latest available version and
          check whether the problem still occurs.
        </li>
        <li>
          <strong>Search existing issues</strong> in the{' '}
          <DocLink href="https://github.com/microsoft/Huabu/issues">
            Huabu issue tracker
          </DocLink>{' '}
          using the error message or a few words that describe the symptom.
        </li>
      </ul>
      <P>
        If an existing issue describes the same problem, add any new
        reproduction details, your Huabu version, and your operating system to
        that issue instead of opening a duplicate.
      </P>

      <H2>Describe the problem</H2>
      <P>
        Use a specific title that describes the visible symptom, such as “PDF
        node becomes blank after reopening a Space.” In the report, include the
        following information:
      </P>
      <Table
        headers={['Field', 'What to include']}
        rows={[
          [
            <strong>What happened</strong>,
            'A short description of the behavior you observed, including any error message.',
          ],
          [
            <strong>What you expected</strong>,
            'What you were trying to do and what you expected Huabu to do instead.',
          ],
          [
            <strong>Steps to reproduce</strong>,
            'A numbered list of the shortest sequence that triggers the problem.',
          ],
          [
            <strong>Frequency</strong>,
            'Whether it happens every time, sometimes, or only once, and whether it also happens in a new Space.',
          ],
        ]}
      />
      <P>For example:</P>
      <CodeBlock language="text">{`What happened
The PDF node is blank after I close and reopen its Space.

Expected behavior
The first page preview should appear after the Space reloads.

Steps to reproduce
1. Open Huabu and create a new Space.
2. Drag a PDF into the Space.
3. Return to Home, then reopen the Space.
4. The PDF node is blank.

Frequency
Every time with this PDF; it also happens in a new Space.`}</CodeBlock>

      <H2>System information</H2>
      <P>
        Include the Huabu version, operating system version, CPU architecture,
        and whether you use the desktop or web app. In the desktop app, choose{' '}
        <strong>Help → Troubleshooting → Copy System Information</strong>, then
        paste the result into the issue.
      </P>

      <H2>Screenshots and logs</H2>
      <P>
        Add a screenshot or short screen recording when the problem is visual or
        difficult to describe. For crashes, failed requests, or unexpected
        errors, choose <strong>Help → Troubleshooting → Open Server Log</strong>{' '}
        and attach only the relevant part of <Code>server.log</Code>.
      </P>
      <Callout tone="warning">
        Review every attachment before uploading it. Remove API keys, access
        tokens, private conversations, personal information, confidential
        documents, and file paths that reveal information you do not want to
        publish.
      </Callout>

      <H2>AI-related problems</H2>
      <P>
        If the problem involves an AI response or edit, also include the details
        below. Share only the minimum context needed to understand the problem.
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Whether you used Chat, Agent mode, or an Agent node, and whether it
          was powered by Huabu Agent or an external agent.
        </li>
        <li>The provider and model name, but never the API key.</li>
        <li>Which nodes or materials were selected as context.</li>
        <li>
          The relevant prompt, response, or proposed edit, if safe to share, and
          whether you applied any proposed changes.
        </li>
      </ul>

      <H2>Submit the issue</H2>
      <P>
        Once the report contains the problem, expected behavior, reproduction
        steps, and system information, create a{' '}
        <DocLink href="https://github.com/microsoft/Huabu/issues/new/choose">
          new GitHub issue
        </DocLink>
        . You can add screenshots or logs by dragging them into the issue
        editor.
      </P>
      <Callout tone="tip">
        A minimal reproduction is more useful than a large attachment. Share a
        sample file or exported Space only when it is necessary, safe to
        publish, and stripped of private content.
      </Callout>
    </PageLayout>
  );
}
