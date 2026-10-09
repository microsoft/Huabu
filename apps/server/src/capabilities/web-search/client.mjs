export function createClient({ config }) {
  return {
    async search(input) {
      const query =
        typeof input === 'string'
          ? input.trim()
          : typeof input?.query === 'string'
            ? input.query.trim()
            : '';
      if (!query) throw new Error('Web search requires a non-empty query');
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(typeof input === 'object' && input ? input : {}),
          api_key: config.apiKey,
          query,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Web search provider request failed (${response.status})`,
        );
      }
      return response.json();
    },
  };
}
