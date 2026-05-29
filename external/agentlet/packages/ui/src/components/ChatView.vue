<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)

function send() {
  const text = input.value.trim()
  if (!text || !session.hasSession || session.isLoading) return
  session.sendPrompt(text)
  input.value = ''
}

// Auto-scroll on new messages
watch(() => session.visibleMessages.length, async () => {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
})
</script>

<template>
  <div class="chat-view">
    <div class="toolbar" v-if="session.hasSession">
      <label class="toggle-switch">
        <input type="checkbox" :checked="!session.showVerbose" @change="session.showVerbose = !session.showVerbose" />
        <span class="slider"></span>
        <span class="label">Hide thinking &amp; tools</span>
      </label>
    </div>

    <div class="messages" ref="messagesEl">
      <div v-if="!session.isConnected" class="empty-state">
        <p>Select an agent to start chatting.</p>
      </div>
      <div v-else-if="!session.hasSession" class="empty-state">
        <p>Connecting to agent...</p>
      </div>
      <template v-else>
        <div
          v-for="msg in session.visibleMessages"
          :key="msg.id"
          class="message"
          :class="[msg.role, msg.type]"
        >
          <div class="role-badge">
            {{ msg.type === 'thought' ? '💭 thinking' : msg.type === 'tool_call' ? '🔧 tool' : msg.type === 'setup' ? '⚙️ setup' : msg.role }}
          </div>
          <div class="content">{{ msg.content }}</div>
        </div>
        <div v-if="session.isLoading" class="message assistant loading">
          <div class="role-badge">assistant</div>
          <div class="content">Thinking...</div>
        </div>
      </template>
    </div>

    <div class="input-area">
      <input
        v-model="input"
        @keydown.enter="send"
        :disabled="!session.hasSession || session.isLoading"
        placeholder="Type a message..."
        autofocus
      />
      <button @click="send" :disabled="!session.hasSession || session.isLoading || !input.trim()">
        Send
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.toolbar {
  padding: 6px 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #fafafa;
}
.toggle-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #555;
  cursor: pointer;
}
.toggle-switch input {
  display: none;
}
.toggle-switch .slider {
  position: relative;
  width: 36px;
  height: 20px;
  background: #ccc;
  border-radius: 10px;
  transition: background 0.2s;
}
.toggle-switch .slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.toggle-switch input:checked + .slider {
  background: #2196f3;
}
.toggle-switch input:checked + .slider::after {
  transform: translateX(16px);
}
.toggle-switch .label {
  user-select: none;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #999;
  font-size: 15px;
}
.message {
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 8px;
  max-width: 80%;
}
.message.user {
  background: #e3f2fd;
  margin-left: auto;
}
.message.assistant.message {
  background: #e8f5e9;
  border-left: 3px solid #66bb6a;
}
.message.assistant.thought {
  background: #f5f5f5;
  color: #888;
  font-style: italic;
  opacity: 0.85;
}
.message.assistant.tool_call {
  background: #e8f5e9;
  border-left: 3px solid #66bb6a;
  font-family: monospace;
  font-size: 12px;
}
.message.system.setup {
  background: #e0f7fa;
  border-left: 3px solid #26c6da;
  font-size: 12px;
  font-family: monospace;
  text-align: left;
  max-width: 80%;
}
.message.system {
  background: #fff3e0;
  max-width: 100%;
  text-align: center;
  font-size: 13px;
  color: #666;
}
.message.loading .content {
  color: #999;
  font-style: italic;
}
.role-badge {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #666;
  margin-bottom: 4px;
}
.content {
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e0e0e0;
  background: #fff;
}
input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 14px;
  outline: none;
}
input:focus {
  border-color: #2196f3;
}
button {
  padding: 10px 20px;
  background: #2196f3;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
button:disabled {
  background: #ccc;
  cursor: not-allowed;
}
button:not(:disabled):hover {
  background: #1976d2;
}
</style>
