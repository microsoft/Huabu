/**
 * ACP WebSocket transport for the UI.
 * Connects to /agents/:agentId/ws on the standalone server.
 * Sends/receives raw ACP JSON-RPC messages.
 */

export type JsonRpcMessage = {
  jsonrpc: '2.0'
  method?: string
  id?: string | number
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type MessageHandler = (msg: JsonRpcMessage) => void
export type CloseHandler = (reason?: string) => void

export class AcpTransport {
  private ws: WebSocket | null = null
  private messageHandlers = new Set<MessageHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private _connected = false

  get connected(): boolean {
    return this._connected
  }

  connect(agentId: string, token?: string): void {
    if (this.ws) {
      this.close()
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let url = `${protocol}//${window.location.host}/agents/${encodeURIComponent(agentId)}/ws`
    if (token) {
      url += `?token=${encodeURIComponent(token)}`
    }

    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this._connected = true
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as JsonRpcMessage
        for (const handler of this.messageHandlers) {
          handler(msg)
        }
      } catch {
        // skip invalid JSON
      }
    }

    this.ws.onclose = (event) => {
      this._connected = false
      this.ws = null
      for (const handler of this.closeHandlers) {
        handler(event.reason || 'connection_closed')
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after this
    }
  }

  send(msg: JsonRpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
      this._connected = false
    }
    this.messageHandlers.clear()
    this.closeHandlers.clear()
  }
}
