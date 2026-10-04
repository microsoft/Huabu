// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

interface AgentletMachineDisplayMetadata {
  hostname?: string;
  platform?: string;
  arch?: string;
}

export function formatAgentletDeviceDisplayName(
  machine?: AgentletMachineDisplayMetadata,
): string {
  const hostname = machine?.hostname?.trim() || 'Agentlet';
  const environment = [machine?.platform, machine?.arch]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' ');
  return environment ? `${hostname}: ${environment}` : hostname;
}
