import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { AcpTransport, type JsonRpcMessage } from '../lib/transport'
import { useAgentsStore } from './agents'
import type {
  InitializeRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
} from '@agentclientprotocol/sdk'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  type: 'message' | 'thought' | 'tool_call' | 'setup'
  content: string
  timestamp: number
}

export const useSessionStore = defineStore('session', () => {
  const messages = ref<ChatMessage[]>([])
  const isConnected = ref(false)
  const isLoading = ref(false)
  const showVerbose = ref(true)
  const sessionId = ref<string | null>(null)
  const transport = new AcpTransport()
  let nextId = 1
  let initializeId = 0
  let sessionNewId = 0

  const hasSession = computed(() => sessionId.value !== null)
  const visibleMessages = computed(() =>
    showVerbose.value
      ? messages.value
      : messages.value.filter(m => m.type === 'message')
  )

  function connectToAgent(agentId: string) {
    const agentsStore = useAgentsStore()
    transport.close()
    messages.value = []
    sessionId.value = null
    isConnected.value = false
    isLoading.value = false
    nextId = 1
    initializeId = 0
    sessionNewId = 0

    transport.connect(agentId, agentsStore.userToken || undefined)

    transport.onMessage((msg) => {
      console.log('[agentlet-ui] ← received:', JSON.stringify(msg))
      handleMessage(msg)
    })

    transport.onClose((reason) => {
      console.log('[agentlet-ui] WS closed:', reason)
      isConnected.value = false
    })

    // Wait for connection then initialize
    const checkOpen = setInterval(() => {
      if (transport.connected) {
        clearInterval(checkOpen)
        isConnected.value = true
        console.log('[agentlet-ui] WS connected, sending initialize...')
        initialize()
      }
    }, 50)

    setTimeout(() => clearInterval(checkOpen), 10000)
  }

  function initialize() {
    initializeId = nextId++
    const params: InitializeRequest = {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'Agentlet UI', version: '0.1.0' },
    }
    const msg = { jsonrpc: '2.0' as const, method: 'initialize', id: initializeId, params }
    console.log('[agentlet-ui] → sending:', JSON.stringify(msg))
    transport.send(msg)
  }

  function startSession() {
    if (!isConnected.value) return
    sessionNewId = nextId++
    const params: NewSessionRequest = {
      cwd: '/',
      mcpServers: [],
    }
    transport.send({ jsonrpc: '2.0', method: 'session/new', id: sessionNewId, params })
  }

  function sendPrompt(text: string) {
    if (!sessionId.value || !isConnected.value) return

    messages.value.push({
      id: `msg-${Date.now()}`,
      role: 'user',
      type: 'message',
      content: text,
      timestamp: Date.now(),
    })

    isLoading.value = true
    const id = nextId++
    const params: PromptRequest = {
      sessionId: sessionId.value,
      prompt: [{ type: 'text', text }],
    }
    transport.send({ jsonrpc: '2.0', method: 'session/prompt', id, params })
  }

  function handleMessage(msg: JsonRpcMessage) {
    // Error response
    if (msg.error) {
      isLoading.value = false
      messages.value.push({
        id: `msg-${Date.now()}`,
        role: 'system',
        type: 'message',
        content: `Error: ${msg.error.message}`,
        timestamp: Date.now(),
      })
      return
    }

    // Response to initialize
    if (msg.id === initializeId && msg.result) {
      startSession()
      return
    }

    // Response to session/new
    if (msg.id === sessionNewId && msg.result) {
      const result = msg.result as NewSessionResponse
      if (result.sessionId && !sessionId.value) {
        sessionId.value = result.sessionId
      }
      return
    }

    // Response to session/prompt (any other response with result while session active)
    if (msg.id && msg.result && sessionId.value) {
      isLoading.value = false
      return
    }

    // Streaming notification (session/update)
    if (msg.method === 'session/update' && msg.params) {
      const params = msg.params as Record<string, unknown>

      // If session/update arrives before session/new response, adopt the sessionId
      if (!sessionId.value && typeof params.sessionId === 'string') {
        sessionId.value = params.sessionId
      }

      const update = params.update as Record<string, unknown> | undefined
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const content = update.content as { type: string; text?: string } | undefined
        if (content?.type === 'text' && content.text) {
          const last = messages.value[messages.value.length - 1]
          if (last?.role === 'assistant' && last.type === 'message') {
            last.content += content.text
          } else {
            messages.value.push({
              id: `msg-${Date.now()}`,
              role: 'assistant',
              type: 'message',
              content: content.text,
              timestamp: Date.now(),
            })
          }
        }
      } else if (update?.sessionUpdate === 'agent_thought_chunk') {
        const content = update.content as { type: string; text?: string } | undefined
        if (content?.type === 'text' && content.text) {
          const last = messages.value[messages.value.length - 1]
          if (last?.role === 'assistant' && last.type === 'thought') {
            last.content += content.text
          } else {
            messages.value.push({
              id: `msg-${Date.now()}-thought`,
              role: 'assistant',
              type: 'thought',
              content: content.text,
              timestamp: Date.now(),
            })
          }
        }
      } else if (update?.sessionUpdate === 'tool_call') {
        const name = (update as Record<string, unknown>).name as string ?? 'unknown'
        const status = (update as Record<string, unknown>).status as string ?? ''
        messages.value.push({
          id: `msg-${Date.now()}-tool`,
          role: 'assistant',
          type: 'tool_call',
          content: `Tool: ${name}${status ? ` (${status})` : ''}`,
          timestamp: Date.now(),
        })
      } else if (update?.sessionUpdate === 'tool_call_update') {
        const last = messages.value[messages.value.length - 1]
        if (last?.type === 'tool_call') {
          const content = (update as Record<string, unknown>).content as { type: string; text?: string } | undefined
          if (content?.type === 'text' && content.text) {
            last.content += '\n' + content.text
          }
        }
      } else if (update?.sessionUpdate === 'config_option_update') {
        const opts = (update as Record<string, unknown>).configOptions as Array<Record<string, unknown>> | undefined
        if (opts?.length) {
          const summary = opts.map(o => `${o.name ?? o.id}: ${o.currentValue ?? ''}`).join(', ')
          messages.value.push({
            id: `msg-${Date.now()}-cfg`,
            role: 'system',
            type: 'setup',
            content: `⚙️ Config: ${summary}`,
            timestamp: Date.now(),
          })
        }
      } else if (update?.sessionUpdate === 'available_commands_update') {
        const cmds = (update as Record<string, unknown>).availableCommands as Array<Record<string, unknown>> | undefined
        if (cmds?.length) {
          messages.value.push({
            id: `msg-${Date.now()}-cmds`,
            role: 'system',
            type: 'setup',
            content: `📋 ${cmds.length} commands available`,
            timestamp: Date.now(),
          })
        }
      } else if (update?.sessionUpdate === 'session_info_update') {
        const title = (update as Record<string, unknown>).title as string | undefined
        if (title) {
          messages.value.push({
            id: `msg-${Date.now()}-info`,
            role: 'system',
            type: 'setup',
            content: `📝 Session: ${title}`,
            timestamp: Date.now(),
          })
        }
      } else if (update?.sessionUpdate === 'current_mode_update') {
        const mode = (update as Record<string, unknown>).mode as Record<string, unknown> | undefined
        if (mode?.name) {
          messages.value.push({
            id: `msg-${Date.now()}-mode`,
            role: 'system',
            type: 'setup',
            content: `🔄 Mode: ${mode.name}`,
            timestamp: Date.now(),
          })
        }
      }
      return
    }
  }

  function disconnect() {
    transport.close()
    isConnected.value = false
    sessionId.value = null
  }

  return {
    messages,
    visibleMessages,
    showVerbose,
    isConnected,
    isLoading,
    sessionId,
    hasSession,
    connectToAgent,
    sendPrompt,
    disconnect,
  }
})
