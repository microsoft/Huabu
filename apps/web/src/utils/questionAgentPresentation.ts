// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getDefaultAgentIcon, readAgentIcon } from './agentIcon';

import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type {
  AgentBinding,
  AgentIcon,
  AgentMode,
  CustomData,
} from '@huabu/shared';

export type QuestionAgentProfile = {
  id: string;
  alias: string;
  customData?: CustomData;
};

export type QuestionAgentPresentation =
  | { kind: 'internal'; alias: 'Huabu'; mode: AgentMode }
  | { kind: 'external'; alias: string; icon: AgentIconValue };

export function resolveQuestionAgentPresentation({
  binding,
  fallbackIcon,
  profiles,
  agentMode = 'ask',
}: {
  binding: AgentBinding;
  fallbackIcon?: AgentIcon;
  profiles: readonly QuestionAgentProfile[];
  /**
   * Built-in mode carried by the node/thread. Only meaningful for the
   * internal agent (Chat vs Agent face); ignored for external bindings.
   */
  agentMode?: AgentMode;
}): QuestionAgentPresentation {
  if (binding.kind === 'internal') {
    return { kind: 'internal', alias: 'Huabu', mode: agentMode };
  }

  const profile = profiles.find(
    (candidate) => candidate.id === binding.profileId,
  );
  if (profile) {
    return {
      kind: 'external',
      alias: profile.alias,
      icon: readAgentIcon(profile),
    };
  }

  return {
    kind: 'external',
    alias: binding.alias,
    icon: fallbackIcon ?? getDefaultAgentIcon(binding.profileId),
  };
}
