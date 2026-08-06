/** Build a stable opaque host SecretStore key for one member environment field. */
export function agentTeamMemberSecretId(
  machine: string,
  manifestPath: string,
  fieldName: string,
): string {
  const identity = JSON.stringify([machine, manifestPath, fieldName]);
  return `agent-team:member-env:${Buffer.from(identity).toString('base64url')}`;
}
