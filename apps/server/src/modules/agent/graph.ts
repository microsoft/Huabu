import { StateGraph, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';

import { getLLM } from './llm.js';
import { AgentState } from './state.js';
import { tools } from './tools/index.js';

import type { AIMessage } from '@langchain/core/messages';

// 1. Node: Call the LLM
const callModel = async (state: typeof AgentState.State) => {
  const model = getLLM();
  const modelWithTools = model.bindTools(tools);

  // Invoke the model with the current history
  const response = await modelWithTools.invoke(state.messages);

  // Return the new message to be appended to history
  return { messages: [response] };
};

// 2. Node: Execute Tools
// We use the prebuilt ToolNode which automatically handles tool invocation and output formatting
const toolNode = new ToolNode(tools);

// 3. Conditional Logic: Continue or End
const shouldContinue = (state: typeof AgentState.State) => {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

  // If the LLM requested a tool call, route to "tools"
  if (lastMessage.tool_calls && lastMessage?.tool_calls?.length > 0) {
    return 'tools';
  }

  // Otherwise, stop (reply to user)
  return END;
};

// 4. Build the Graph
export const createGraph = () => {
  const workflow = new StateGraph(AgentState)
    .addNode('agent', callModel)
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges(
      'agent',
      shouldContinue,
      // Map return values of shouldContinue to Node names
      {
        tools: 'tools',
        [END]: END,
      },
    )
    .addEdge('tools', 'agent'); // After tool runs, feed result back to agent

  return workflow.compile();
};
