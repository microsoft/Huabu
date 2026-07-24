// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertTriangle, ShieldQuestion } from 'lucide-react';

import './AgentNodeStatusGuide.css';

type BuiltInMode = 'chat' | 'agent';
type ExternalShape = 'diamond' | 'spark' | 'flower' | 'cloud';
type ExternalColor = 'blue' | 'red' | 'yellow' | 'green';

const EXTERNAL_COLORS: Record<ExternalColor, string> = {
  blue: '#00a4ef',
  red: '#f25022',
  yellow: '#ffb900',
  green: '#7fba00',
};

const EXTERNAL_FACE_PATHS: Record<ExternalShape, readonly string[]> = {
  diamond: ['M50 50 48 59', 'M70 49 69 57', 'M65 66c-5 1-6 8-1 10 5 1 8-4 5-8'],
  spark: ['M50 51 49 58', 'M69 49 68 57', 'M55 68c4 4 9 4 12 0'],
  flower: ['M50 49 48 57', 'M70 51 68 58', 'M55 69c3 4 9 5 13 1'],
  cloud: ['M50 50 49 58', 'M70 50 69 58', 'M54 69c4 4 10 5 14 1'],
};

type AgentAvatarProps = {
  mode?: BuiltInMode;
  shape?: ExternalShape;
  color?: ExternalColor;
  working?: boolean;
};

function BuiltInAgentAvatar({ mode }: { mode: BuiltInMode }) {
  const isAgent = mode === 'agent';

  return (
    <svg viewBox="14 10.5 92 92" aria-hidden>
      <polygon
        points="60,24 71.2,44.6 94.2,48.9 78.1,65.9 81.2,89.1 60,79 38.8,89.1 41.9,65.9 25.8,48.9 48.8,44.6"
        fill="#00a4ef"
        stroke="#00a4ef"
        strokeWidth="11"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <g
        fill="none"
        stroke="#24221e"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isAgent ? (
          <>
            <path d="M51 52 50 59" />
            <path d="M70 52 69 59" />
            <path d="M55 67c4 2 8 2 12 0" />
            <path d="M41 78c-7-5-9-12-6-18" />
            <path d="M79 78c7-5 9-12 6-18" />
          </>
        ) : (
          <path d="M52 66c4 6 12 6 16 0" />
        )}
      </g>
      {isAgent ? (
        <>
          <circle
            cx="34"
            cy="57"
            r="4.4"
            fill="#00a4ef"
            stroke="#24221e"
            strokeWidth="2.4"
          />
          <circle
            cx="86"
            cy="57"
            r="4.4"
            fill="#00a4ef"
            stroke="#24221e"
            strokeWidth="2.4"
          />
        </>
      ) : (
        <>
          <circle cx="52" cy="55" r="3.5" fill="#24221e" />
          <circle cx="68" cy="55" r="3.5" fill="#24221e" />
        </>
      )}
    </svg>
  );
}

function ExternalShapeBody({
  shape,
  fill,
}: {
  shape: ExternalShape;
  fill: string;
}) {
  switch (shape) {
    case 'diamond':
      return <polygon points="60,18 102,60 60,102 18,60" fill={fill} />;
    case 'spark':
      return (
        <polygon
          points="60,23 72,48 98,60 72,72 60,97 48,72 22,60 48,48"
          fill={fill}
        />
      );
    case 'flower':
      return (
        <g fill={fill}>
          <circle cx="60" cy="38" r="16" />
          <circle cx="81" cy="53" r="16" />
          <circle cx="73" cy="78" r="16" />
          <circle cx="47" cy="78" r="16" />
          <circle cx="39" cy="53" r="16" />
          <circle cx="60" cy="60" r="17" />
        </g>
      );
    case 'cloud':
      return (
        <path
          d="M66 19C84 19 99 30 101 45C103 58 94 65 86 70C78 75 82 87 73 95C63 104 45 102 32 92C18 82 15 65 21 50C27 34 42 25 54 21C58 20 62 19 66 19Z"
          fill={fill}
          transform="translate(7.008 7.008) scale(0.8832)"
        />
      );
  }
}

function AgentAvatar({
  mode,
  shape = 'flower',
  color = 'green',
  working = false,
}: AgentAvatarProps) {
  if (mode) {
    return (
      <span className={working ? 'agent-status-avatar-working' : undefined}>
        <BuiltInAgentAvatar mode={mode} />
      </span>
    );
  }

  return (
    <svg viewBox="18 18 84 84" aria-hidden>
      <g className={working ? 'agent-status-avatar-working' : undefined}>
        <ExternalShapeBody shape={shape} fill={EXTERNAL_COLORS[color]} />
      </g>
      <g
        fill="none"
        stroke="#24221e"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {EXTERNAL_FACE_PATHS[shape].map((path) => (
          <path key={path} d={path} />
        ))}
      </g>
    </svg>
  );
}

type StatusExample = {
  state:
    | 'open'
    | 'running'
    | 'approval'
    | 'unread'
    | 'error'
    | 'conflict'
    | 'viewed';
  label: string;
  detail: string;
};

const STATUS_EXAMPLES: readonly StatusExample[] = [
  { state: 'open', label: 'Conversation open', detail: 'Open in Chat Panel' },
  { state: 'running', label: 'Running', detail: 'Agent is working' },
  {
    state: 'approval',
    label: 'Permission required',
    detail: 'Review the request',
  },
  { state: 'unread', label: 'Done · unread', detail: 'New answer to view' },
  { state: 'error', label: 'Error', detail: 'Run failed' },
  { state: 'conflict', label: 'Changes skipped', detail: 'Review conflicts' },
  { state: 'viewed', label: 'Done · viewed', detail: 'No action needed' },
];

function StatusMark({ state }: Pick<StatusExample, 'state'>) {
  const working = state === 'running';

  return (
    <div className={`agent-status-mark agent-status-mark-${state}`}>
      {state === 'open' ? (
        <svg viewBox="0 0 44 48" className="agent-status-bubble" aria-hidden>
          <path
            d="M22 2C11 2 2 11 2 22c0 8 4.5 14.5 11 18l-4 6 9-4.5c1.3.3 2.6.5 4 .5 11 0 20-9 20-20S33 2 22 2Z"
            fill="var(--agent-status-sticker)"
            stroke="var(--agent-status-question-border)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      <span className="agent-status-avatar">
        <AgentAvatar working={working} />
      </span>
      {state === 'approval' ? (
        <span
          className="agent-status-satellite agent-status-satellite-approval"
          aria-hidden
        >
          <ShieldQuestion aria-hidden size={12} />
        </span>
      ) : null}
      {state === 'conflict' ? (
        <span
          className="agent-status-satellite agent-status-satellite-conflict"
          aria-hidden
        >
          <AlertTriangle aria-hidden size={12} />2
        </span>
      ) : null}
    </div>
  );
}

export function HuabuAgentIdentityGuide() {
  return (
    <div className="agent-status-guide agent-identity-guide">
      <div className="agent-status-identities agent-status-built-in-identities">
        <div className="agent-status-identity">
          <span className="agent-status-identity-avatar">
            <AgentAvatar mode="chat" />
          </span>
          <span>
            <strong>Huabu Chat</strong>
            <small>A plain conversation</small>
          </span>
        </div>
        <div className="agent-status-identity">
          <span className="agent-status-identity-avatar">
            <AgentAvatar mode="agent" />
          </span>
          <span>
            <strong>Huabu Agent</strong>
            <small>Can also act on your Space</small>
          </span>
        </div>
      </div>
    </div>
  );
}

export function ExternalAgentIconGuide() {
  return (
    <div className="agent-status-guide agent-identity-guide">
      <div className="agent-status-identities agent-status-external-identities">
        <div className="agent-status-identity agent-status-identity-external">
          <span className="agent-status-external-avatars" aria-hidden>
            <span>
              <AgentAvatar shape="diamond" color="blue" />
            </span>
            <span>
              <AgentAvatar shape="spark" color="red" />
            </span>
            <span>
              <AgentAvatar shape="flower" color="yellow" />
            </span>
            <span>
              <AgentAvatar shape="cloud" color="green" />
            </span>
          </span>
          <span>
            <strong>External Agents</strong>
            <small>Choose the Profile icon shape and color</small>
          </span>
        </div>
      </div>
    </div>
  );
}

export function AgentNodeStatusGuide() {
  return (
    <div className="agent-status-guide">
      <div className="agent-status-grid">
        {STATUS_EXAMPLES.map((example) => (
          <figure key={example.state} className="agent-status-example">
            <div className="agent-status-stage">
              <StatusMark state={example.state} />
            </div>
            <figcaption>
              <strong>{example.label}</strong>
              <span>{example.detail}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
