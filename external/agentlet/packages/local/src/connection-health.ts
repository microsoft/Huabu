import WebSocket from 'ws'

/** Bound both the hello exchange and half-open connections after network loss. */
export function monitorConnection(
  socket: WebSocket,
  heartbeatSeconds: number,
): { handshakeComplete(): void; stop(): void } {
  let alive = true
  const handshakeTimer = setTimeout(() => socket.terminate(), 10_000)
  handshakeTimer.unref()
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearTimeout(handshakeTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  }
  socket.on('pong', () => { alive = true })
  socket.once('open', () => {
    if (heartbeatSeconds <= 0) return
    heartbeatTimer = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      if (socket.readyState === WebSocket.OPEN) {
        alive = false
        socket.ping()
      }
    }, heartbeatSeconds * 1000)
    heartbeatTimer.unref()
  })
  socket.once('close', stop)
  return {
    handshakeComplete: () => clearTimeout(handshakeTimer),
    stop,
  }
}
