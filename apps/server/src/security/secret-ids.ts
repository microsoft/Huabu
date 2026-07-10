export const SECRET_IDS = {
  imageApiKey: 'llm:image:api-key',
  tavilyApiKey: 'integration:tavily:api-key',
  rapidApiKey: 'integration:rapidapi:api-key',
  copilotOAuth: 'oauth:github-copilot:credentials',
} as const;

export function llmProviderApiKeySecretId(provider: string): string {
  return `llm:provider:${provider}:api-key`;
}
