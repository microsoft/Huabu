// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CommandProfileForm } from './CommandProfileForm';
import { CreateAgentProfile } from './CreateAgentProfile';

import type {
  AcpAgentCliInfo,
  AgentProfileView,
  ConnectedAgentletDevice,
} from '@huabu/shared';

type AgentProfileEditorProps = {
  detectedClis: AcpAgentCliInfo[];
  detectionLoaded: boolean;
  detectionError?: string | null;
  onRecheck?: () => void;
  connectedDevices: ConnectedAgentletDevice[];
  agentletId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
} & ({ mode: 'create' } | { mode: 'edit-command'; profile: AgentProfileView });

export function AgentProfileEditor(props: AgentProfileEditorProps) {
  if (props.mode === 'create') {
    return <CreateAgentProfile key={props.agentletId} {...props} />;
  }
  return (
    <CommandProfileForm
      key={`${props.profile.id}:${props.profile.revision ?? 0}`}
      editing={props.profile}
      detectedClis={props.detectedClis}
      detectionLoaded={props.detectionLoaded}
      connectedDevices={props.connectedDevices}
      agentletId={props.agentletId}
      onClose={props.onClose}
      onSaved={props.onSaved}
      detectionError={props.detectionError}
      onRecheck={props.onRecheck}
    />
  );
}
