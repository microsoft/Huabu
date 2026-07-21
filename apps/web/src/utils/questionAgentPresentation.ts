import { getDefaultAgentIcon, readAgentIcon } from './agentIcon';

import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type { AgentBinding, AgentIcon, CustomData } from '@sediment/shared';

export type QuestionAgentProfile = {
  id: string;
  alias: string;
  customData?: CustomData;
};

export type QuestionAgentPresentation =
  | { kind: 'internal'; alias: 'Huabu' }
  | { kind: 'external'; alias: string; icon: AgentIconValue };

export function resolveQuestionAgentPresentation({
  binding,
  fallbackIcon,
  profiles,
}: {
  binding: AgentBinding;
  fallbackIcon?: AgentIcon;
  profiles: readonly QuestionAgentProfile[];
}): QuestionAgentPresentation {
  if (binding.kind === 'internal') {
    return { kind: 'internal', alias: 'Huabu' };
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
