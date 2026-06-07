import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type JsonRpcMessage = {
  jsonrpc: '2.0'
  method?: string
  id?: string | number
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  type: 'message' | 'thought' | 'tool_call' | 'setup'
  content: string
  timestamp: number
}

export interface AvailableCommand {
  name: string
  description?: string
  input?: { hint?: string }
}

/** localStorage key prefix for persisting lastSeq per session */
const SEQ_PREFIX = 'agentlet:lastSeq:'

export const useSessionStore = defineStore('session', () => {
  const messages = ref<ChatMessage[]>([])
  const isConnected = ref(false)
  const isLoading = ref(false)
  const showVerbose = ref(true)
  const sessionId = ref<string | null>(null)
  const availableCommands = ref<AvailableCommand[]>([])
  const isReplaying = ref(false)
  let nextId = 1

  /** Singleton host WS connection */
  let hostWs: WebSocket | null = null
  /** Currently subscribed sessionId (only one at a time) */
  let subscribedSession: string | null = null
  /** SessionId whose messages are currently loaded in messages[] */
  let loadedSessionId: string | null = null

  const hasSession = computed(() => sessionId.value !== null)
  const visibleMessages = computed(() =>
    showVerbose.value
      ? messages.value
      : messages.value.filter(m => m.type === 'message')
  )

  /** Ensure the host WS is connected. Returns the WebSocket instance. */
  function ensureHostWs(token?: string): WebSocket {
    if (hostWs && hostWs.readyState === WebSocket.OPEN) return hostWs

    // Close stale WS if any
    if (hostWs) {
      hostWs.onclose = null
      hostWs.onerror = null
      hostWs.onmessage = null
      hostWs.close()
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/host${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const ws = new WebSocket(url)
    hostWs = ws

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as JsonRpcMessage
        handleHostMessage(msg)
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      isConnected.value = false
      subscribedSession = null
    }

    ws.onerror = () => {
      isConnected.value = false
    }

    return ws
  }

  /** Handle a JSON-RPC message from the host WS */
  function handleHostMessage(msg: JsonRpcMessage) {
    const method = msg.method
    const params = (msg.params ?? {}) as Record<string, unknown>

    switch (method) {
      case 'server/event': {
        const evtSessionId = params.sessionId as string | undefined
        if (evtSessionId && evtSessionId !== sessionId.value) break
        const entry = {
          seq: params.seq as number,
          ts: params.ts as string,
          dir: params.dir as 'agent' | 'host',
          event: params.event as JsonRpcMessage,
        }
        processEvent(entry)
        if (sessionId.value) {
          localStorage.setItem(SEQ_PREFIX + sessionId.value, String(entry.seq))
        }
        break
      }
      case 'server/replayed': {
        isReplaying.value = false
        const lastSeq = params.lastSeq as number
        if (sessionId.value) {
          localStorage.setItem(SEQ_PREFIX + sessionId.value, String(lastSeq))
        }
        console.log(`[agentlet-ui] Replay complete, lastSeq=${lastSeq}`)
        break
      }
      case 'agent/connected': {
        console.log(`[agentlet-ui] Agent connected: ${params.sessionId}`)
        break
      }
      case 'agent/disconnected': {
        console.log(`[agentlet-ui] Agent disconnected: ${params.sessionId} (${params.reason})`)
        break
      }
      case 'server/error': {
        const code = params.code as string
        const message = params.message as string
        console.error(`[agentlet-ui] Error: ${code}: ${message}`)
        if (code === 'NO_ACTIVE_AGENT') {
          // Agent is not connected — UI can still display history
        }
        break
      }
    }
  }

  /**
   * Connect to a session via the /api/host WS with subscribe.
   * Replays historical events and then streams live events.
   */
  function connectToSession(targetSessionId: string, token?: string) {
    // Unsubscribe from previous session
    if (subscribedSession && hostWs?.readyState === WebSocket.OPEN) {
      hostWs.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'host/unsubscribe',
        params: { sessionId: subscribedSession },
      }))
    }

    sessionId.value = targetSessionId
    isReplaying.value = true

    // Recover lastSeq for delta sync — only reuse messages if they belong to this session
    const cachedSeq = parseInt(localStorage.getItem(SEQ_PREFIX + targetSessionId) || '0', 10)
    const sameSession = loadedSessionId === targetSessionId
    const afterSeq = cachedSeq > 0 && sameSession && messages.value.length > 0 ? cachedSeq : 0
    if (afterSeq === 0) {
      messages.value = []
    }
    loadedSessionId = targetSessionId

    const ws = ensureHostWs(token)

    const doSubscribe = () => {
      subscribedSession = targetSessionId
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'host/subscribe',
        params: { sessionId: targetSessionId, afterSeq },
      }))
      isConnected.value = true
      console.log(`[agentlet-ui] Subscribed to session: ${targetSessionId} (afterSeq=${afterSeq})`)
    }

    if (ws.readyState === WebSocket.OPEN) {
      doSubscribe()
    } else {
      ws.addEventListener('open', doSubscribe, { once: true })
    }
  }

  interface EventEntry {
    seq: number
    ts: string
    dir: 'agent' | 'host'
    event: JsonRpcMessage
  }

  /**
   * Process a single event entry.
   * Host events reconstruct user messages; agent events go through handleMessage.
   */
  function processEvent(entry: EventEntry) {
    const ts = new Date(entry.ts).getTime()

    if (entry.dir === 'host') {
      const msg = entry.event
      if (msg.method === 'session/prompt' && msg.params) {
        const params = msg.params as Record<string, unknown>
        const prompt = params.prompt as Array<{ type: string; text?: string }> | undefined
        if (prompt) {
          const text = prompt.filter(p => p.type === 'text').map(p => p.text || '').join('')
          if (text) {
            messages.value.push({
              id: `msg-seq-${entry.seq}`,
              role: 'user',
              type: 'message',
              content: text,
              timestamp: ts,
            })
            isLoading.value = true
          }
        }
      }
    } else {
      handleMessage(entry.event, ts)
    }
  }

  function sendPrompt(text: string) {
    if (!sessionId.value || !isConnected.value || !hostWs) return

    // User messages are reconstructed from replayed host events
    // (fire-and-forget: server persists and echoes back via subscription)
    isLoading.value = true
    const id = nextId++
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/prompt',
      id,
      params: {
        sessionId: sessionId.value,
        prompt: [{ type: 'text', text }],
      },
    }

    hostWs.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'host/send',
      params: { sessionId: sessionId.value, message: msg },
    }))
  }

  function handleMessage(msg: JsonRpcMessage, timestamp?: number) {
    const ts = timestamp ?? Date.now()
    if (msg.error) {
      isLoading.value = false
      messages.value.push({
        id: `msg-${ts}`,
        role: 'system',
        type: 'message',
        content: `Error: ${msg.error.message}`,
        timestamp: ts,
      })
      return
    }

    if (msg.id && msg.result && sessionId.value) {
      isLoading.value = false
      return
    }

    if (msg.method === 'session/update' && msg.params) {
      const params = msg.params as Record<string, unknown>

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
              id: `msg-${ts}`,
              role: 'assistant',
              type: 'message',
              content: content.text,
              timestamp: ts,
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
              id: `msg-${ts}-thought`,
              role: 'assistant',
              type: 'thought',
              content: content.text,
              timestamp: ts,
            })
          }
        }
      } else if (update?.sessionUpdate === 'tool_call') {
        const toolCallId = (update as Record<string, unknown>).toolCallId as string ?? ''
        const title = (update as Record<string, unknown>).title as string
          ?? (update as Record<string, unknown>).name as string
          ?? (update as Record<string, unknown>).kind as string
          ?? 'tool'
        const status = (update as Record<string, unknown>).status as string ?? ''
        messages.value.push({
          id: toolCallId || `msg-${ts}-tool`,
          role: 'assistant',
          type: 'tool_call',
          content: `${title}${status ? ` (${status})` : ''}`,
          timestamp: ts,
        })
      } else if (update?.sessionUpdate === 'tool_call_update') {
        const toolCallId = (update as Record<string, unknown>).toolCallId as string ?? ''
        let target = toolCallId
          ? messages.value.find(m => m.id === toolCallId)
          : messages.value.findLast(m => m.type === 'tool_call')

        if (!target) {
          const title = (update as Record<string, unknown>).title as string ?? 'tool'
          target = {
            id: toolCallId || `msg-${ts}-tool`,
            role: 'assistant',
            type: 'tool_call',
            content: title,
            timestamp: ts,
          }
          messages.value.push(target)
        }

        const status = (update as Record<string, unknown>).status as string | undefined
        const title = (update as Record<string, unknown>).title as string | undefined
        if (title) {
          target.content = target.content.replace(/^[^(\n]+/, `${title} `)
        }
        if (status === 'completed' || status === 'error' || status === 'failed') {
          target.content = target.content.replace(/ \([^)]*\)/, '') + ` (${status})`
        }
        const contentArr = (update as Record<string, unknown>).content as Array<{ type: string; content?: { type: string; text?: string }; text?: string }> | undefined
        if (contentArr) {
          for (const item of contentArr) {
            const text = item.content?.text ?? item.text
            if (text) {
              target.content += '\n' + text
            }
          }
        }
      } else if (update?.sessionUpdate === 'config_option_update') {
        const opts = (update as Record<string, unknown>).configOptions as Array<Record<string, unknown>> | undefined
        if (opts?.length) {
          const summary = opts.map(o => `${o.name ?? o.id}: ${o.currentValue ?? ''}`).join(', ')
          messages.value.push({
            id: `msg-${ts}-cfg`,
            role: 'system',
            type: 'setup',
            content: `⚙️ Config: ${summary}`,
            timestamp: ts,
          })
        }
      } else if (update?.sessionUpdate === 'available_commands_update') {
        const cmds = (update as Record<string, unknown>).availableCommands as Array<Record<string, unknown>> | undefined
        if (cmds) {
          availableCommands.value = cmds.map(c => ({
            name: c.name as string,
            description: c.description as string | undefined,
            input: c.input as { hint?: string } | undefined,
          }))
          messages.value.push({
            id: `msg-${ts}-cmds`,
            role: 'system',
            type: 'setup',
            content: `📋 ${cmds.length} commands available`,
            timestamp: ts,
          })
        }
      } else if (update?.sessionUpdate === 'session_info_update') {
        const title = (update as Record<string, unknown>).title as string | undefined
        if (title) {
          messages.value.push({
            id: `msg-${ts}-info`,
            role: 'system',
            type: 'setup',
            content: `📝 Session: ${title}`,
            timestamp: ts,
          })
        }
      } else if (update?.sessionUpdate === 'current_mode_update') {
        const mode = (update as Record<string, unknown>).mode as Record<string, unknown> | undefined
        if (mode?.name) {
          messages.value.push({
            id: `msg-${ts}-mode`,
            role: 'system',
            type: 'setup',
            content: `🔄 Mode: ${mode.name}`,
            timestamp: ts,
          })
        }
      }
      return
    }
  }

  function disconnect() {
    if (subscribedSession && hostWs?.readyState === WebSocket.OPEN) {
      hostWs.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'host/unsubscribe',
        params: { sessionId: subscribedSession },
      }))
    }
    subscribedSession = null
    loadedSessionId = null
    messages.value = []
    sessionId.value = null
    isConnected.value = false
    isLoading.value = false
    isReplaying.value = false
    availableCommands.value = []
    nextId = 1
    // Note: hostWs stays open for reuse when switching sessions
  }

  return {
    messages,
    visibleMessages,
    showVerbose,
    isConnected,
    isLoading,
    isReplaying,
    sessionId,
    hasSession,
    availableCommands,
    connectToSession,
    sendPrompt,
    disconnect,
  }
})
