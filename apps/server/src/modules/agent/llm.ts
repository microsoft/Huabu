import { AzureChatOpenAI } from '@langchain/openai';

export function getLLM() {
  if (
    !process.env.AZURE_OPENAI_API_KEY ||
    !process.env.AZURE_OPENAI_API_ENDPOINT
  ) {
    throw new Error(
      'Azure OpenAI credentials are missing in environment variables.',
    );
  }

  return new AzureChatOpenAI({
    azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
    azureOpenAIEndpoint: process.env.AZURE_OPENAI_API_ENDPOINT,
    azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
    azureOpenAIApiVersion:
      process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview',
    temperature: 0,
    streaming: true,
    timeout: 60000,
  });
}
