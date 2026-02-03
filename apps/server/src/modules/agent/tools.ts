import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const webSearchTool = tool(
  async ({ query }) => {
    // In a real implementation, this would call Tavily, Bing, or Google Custom Search
    console.log(`[MockTool] Searching for: ${query}`);
    return JSON.stringify([
      {
        title: 'LangGraph Documentation',
        content:
          'LangGraph is a library for building stateful, multi-actor applications with LLMs, built on top of (and intended to be used with) LangChain.',
        url: 'https://langchain-ai.github.io/langgraph/',
      },
      {
        title: 'Current Date',
        content: 'Today is February 3, 2026.',
      },
      {
        title: 'Sediment Project',
        content: 'Sediment is a sediment analysis tool... (Mock Data)',
      },
    ]);
  },
  {
    name: 'web_search',
    description:
      'Search the internet for current events, technical documentation, or specific facts.',
    schema: z.object({
      query: z.string().describe('The search query keywords'),
    }),
  },
);

export const tools = [webSearchTool];
