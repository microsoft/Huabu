// TODO: fill in real handbook content for this section.
import {
  Callout,
  Code,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'opening-settings', label: 'Opening settings' },
  { id: 'providers-and-models', label: 'Providers and models' },
  { id: 'api-key', label: 'API key' },
  { id: 'github-copilot-oauth', label: 'GitHub Copilot OAuth' },
  { id: 'external-agents', label: 'External agents' },
  { id: 'troubleshooting', label: 'Troubleshooting' },
];

export default function Settings() {
  return (
    <PageLayout
      title="Settings & LLM"
      description="Pick which model the AI uses, how it authenticates with your provider, and how to connect external coding-agent CLIs. Settings are application-wide — one configuration is shared across every workspace and canvas."
      toc={toc}
    >
      <H2>Opening settings</H2>
      <P>
        Click the gear icon in the floating top-right controls (visible on every
        canvas). The settings popover has two main sections:{' '}
        <strong>LLM</strong> and <strong>External Agents</strong>.
      </P>

      <H2>Providers and models</H2>
      <Table
        headers={['Field', 'Meaning']}
        rows={[
          [
            <strong>Provider</strong>,
            'OpenAI / Anthropic / Google / Mistral / Groq / GitHub Copilot, and more.',
          ],
          [
            <strong>Model</strong>,
            'Available models populate based on the selected provider.',
          ],
          [
            <strong>Manual model</strong>,
            'Type in any model ID if the model you want isn&apos;t in the list.',
          ],
        ]}
      />
      <P>
        Switching to a provider that has no credentials configured triggers the
        right credential flow automatically (API key or OAuth).
      </P>

      <H2>API key</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Click <strong>Set API Key</strong> in LLM Settings, paste, save.
        </li>
        <li>
          Keys are stored locally and only ever transmitted on the actual model
          call.
        </li>
        <li>Effective immediately — no restart needed.</li>
      </ul>
      <Callout tone="warning">
        API keys are stored as plain JSON in Huabu&apos;s data folder.
        Don&apos;t check the app data folder into a public repository.
      </Callout>

      <H2>GitHub Copilot OAuth</H2>
      <P>Copilot uses an OAuth Device Code flow instead of an API key:</P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          Pick <Code>github-copilot</Code> as the provider.
        </li>
        <li>
          Click <strong>Login with GitHub</strong>.
        </li>
        <li>
          A one-time <strong>User Code</strong> (e.g. <Code>XXXX-XXXX</Code>)
          appears with a GitHub URL.
        </li>
        <li>
          Click the code to copy it; the browser opens the GitHub authorisation
          page automatically.
        </li>
        <li>Paste the code on GitHub and authorise.</li>
        <li>Return to Huabu — &quot;Login successful&quot; confirms.</li>
      </ol>
      <P>
        Tokens refresh themselves. Use <strong>Logout</strong> to clear them if
        you switch accounts.
      </P>
      <P>
        Closed the device-code dialog without finishing? Click Login again — the
        previous flow is cancelled automatically to avoid dangling state.
      </P>

      <H2>External agents</H2>
      <P>
        The External Agents section lists the ACP-capable CLIs Huabu detected on
        your machine (Copilot / Claude / Gemini) and lets you connect any of
        them with one click. Full details (pairing codes, reconnect grace,
        agentlet on PATH) live in{' '}
        <DocLink href="/docs/ai/external-agents">External Agents</DocLink>.
      </P>

      <H2>Troubleshooting</H2>
      <Table
        headers={['Symptom', 'Cause / fix']}
        rows={[
          [
            'Model list is empty after switching provider',
            'No credentials for that provider yet — set an API key or run the OAuth flow.',
          ],
          [
            'Copilot login times out',
            <>
              The 30-second Device Code window expired. Retry, and verify you
              can reach <Code>github.com</Code>.
            </>,
          ],
          [
            '401 / 403 from the AI',
            'Key is invalid or out of quota. Update it in Settings.',
          ],
          [
            'Reply quality dropped noticeably',
            'Check the selected model — Operate runs and complex Intents benefit from a stronger model.',
          ],
          [
            'External agent connection fails with &quot;Invalid or expired pairing code&quot;',
            <>
              Generate a fresh code in Settings. Codes expire after 60 seconds
              if unclaimed, and after a 5-minute grace window once the agent
              disconnects.
            </>,
          ],
        ]}
      />
    </PageLayout>
  );
}
