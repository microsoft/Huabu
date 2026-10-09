export function createClient({ config }) {
  return {
    async generate(input) {
      if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) {
        throw new Error('Image generation requires a non-empty prompt');
      }
      const endpoint = config.baseUrl.replace(/\/+$/, '');
      const deployment = config.model || config.modelFamily;
      const v1Style = /(?:^|\/)(?:openai\/)?v1$/i.test(endpoint);
      const url = v1Style
        ? new URL(`${endpoint}/images/generations`)
        : new URL(
            `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/images/generations`,
          );
      if (!v1Style) url.searchParams.set('api-version', config.apiVersion);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...(v1Style
            ? { authorization: `Bearer ${config.apiKey}` }
            : { 'api-key': config.apiKey }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...input,
          prompt: input.prompt.trim(),
          quality: input.quality || config.quality,
          ...(v1Style ? { model: deployment } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`Image provider request failed (${response.status})`);
      }
      return response.json();
    },
  };
}
