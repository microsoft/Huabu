<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue'
import MarkdownIt from 'markdown-it'
import { useSessionStore } from '../stores/session'
import { useSlashCommandTypeahead } from '../composables/useSlashCommandTypeahead'
import SlashCommandMenu from './SlashCommandMenu.vue'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

function renderMd(content: string): string {
  return md.render(content)
}

const session = useSessionStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const emptyWarning = ref(false)

// Message display limit
const displayLimitOptions = [50, 100, 200, 500, 0] // 0 means "All"
const displayLimit = ref(50)
const displayedMessages = computed(() => {
  const msgs = session.visibleMessages
  if (displayLimit.value === 0 || msgs.length <= displayLimit.value) return msgs
  return msgs.slice(msgs.length - displayLimit.value)
})

// Feature (b): Slash command typeahead
const commands = computed(() => session.availableCommands)
const slash = useSlashCommandTypeahead(input, commands)

function send() {
  const text = input.value.trim()
  if (!session.hasSession) return
  if (!text) {
    emptyWarning.value = true
    setTimeout(() => { emptyWarning.value = false }, 2000)
    return
  }
  emptyWarning.value = false
  session.sendPrompt(text)
  input.value = ''
  nextTick(() => autoResize())
}

function onKeyDown(e: KeyboardEvent) {
  // Let slash typeahead handle first
  if (slash.handleKeyDown(e)) return

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function onInputEvent(e: Event) {
  const el = e.target as HTMLTextAreaElement
  slash.syncCaret(el.selectionStart ?? 0)
  autoResize()
}

function autoResize() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 150) + 'px'
}

function onSelectCommand(cmd: { name: string; description?: string; input?: { hint?: string } }) {
  input.value = slash.accept(cmd)
  nextTick(() => inputEl.value?.focus())
}

// Auto-scroll when new messages arrive or display limit changes
watch(
  () => [session.visibleMessages.length, displayLimit.value] as const,
  async () => {
    await nextTick()
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  }
)
</script>

<template>
  <div class="chat-view">
    <div class="toolbar" v-if="session.hasSession">
      <label class="toggle-switch">
        <input type="checkbox" :checked="!session.showVerbose" @change="session.showVerbose = !session.showVerbose" />
        <span class="slider"></span>
        <span class="label">Hide thinking &amp; tools</span>
      </label>
      <label class="display-limit">
        <span class="label">Show last</span>
        <select v-model.number="displayLimit">
          <option v-for="opt in displayLimitOptions" :key="opt" :value="opt">
            {{ opt === 0 ? 'All' : opt }}
          </option>
        </select>
        <span class="label">messages</span>
        <span v-if="displayLimit > 0 && session.visibleMessages.length > displayLimit" class="truncated-hint">
          ({{ session.visibleMessages.length - displayLimit }} hidden)
        </span>
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
          v-for="msg in displayedMessages"
          :key="msg.id"
          class="message"
          :class="[msg.role, msg.type]"
        >
          <div class="role-badge">
            {{ msg.type === 'thought' ? '💭 thinking' : msg.type === 'tool_call' ? '🔧 tool' : msg.type === 'setup' ? '⚙️ setup' : msg.role }}
          </div>
          <div class="content" v-if="msg.role === 'assistant' && msg.type === 'message'" v-html="renderMd(msg.content)"></div>
          <div class="content" v-else>{{ msg.content }}</div>
        </div>
        <div v-if="session.isLoading" class="message assistant loading">
          <div class="role-badge">assistant</div>
          <div class="content">Thinking...</div>
        </div>
      </template>
    </div>

    <div class="input-area">
      <div class="input-wrapper">
        <SlashCommandMenu
          v-if="slash.isOpen.value"
          :commands="slash.filtered.value"
          :filter="slash.filter.value"
          :highlight-index="slash.highlightIndex.value"
          @select="onSelectCommand"
          @hover="(idx: number) => slash.highlightIndex.value = idx"
        />
        <textarea
          ref="inputEl"
          v-model="input"
          @keydown="onKeyDown"
          @input="onInputEvent"
          @click="onInputEvent"
          @keyup="onInputEvent"
          :disabled="!session.hasSession"
          :placeholder="session.hasSession ? 'Type a message... (/ for commands)' : 'Waiting for connection...'"
          rows="1"
          autofocus
        />
        <span v-if="emptyWarning" class="empty-warning">Please type a message first</span>
      </div>
      <button @click="send" :disabled="!session.hasSession">
        Send
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.toolbar {
  padding: 6px 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #fafafa;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
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
.display-limit {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #555;
}
.display-limit select {
  padding: 2px 6px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 12px;
  background: #fff;
  cursor: pointer;
}
.display-limit .truncated-hint {
  color: #999;
  font-style: italic;
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
.content :deep(p) {
  margin: 0 0 8px;
}
.content :deep(p:last-child) {
  margin-bottom: 0;
}
.content :deep(pre) {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 10px 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 13px;
  margin: 8px 0;
}
.content :deep(code) {
  background: #e8e8e8;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 13px;
}
.content :deep(pre code) {
  background: none;
  padding: 0;
}
.content :deep(ul),
.content :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}
.content :deep(blockquote) {
  border-left: 3px solid #ccc;
  margin: 8px 0;
  padding: 4px 12px;
  color: #666;
}
.content :deep(a) {
  color: #1976d2;
  text-decoration: none;
}
.content :deep(a:hover) {
  text-decoration: underline;
}
.content :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
}
.content :deep(th),
.content :deep(td) {
  border: 1px solid #ddd;
  padding: 4px 8px;
  font-size: 13px;
}
.content :deep(th) {
  background: #f5f5f5;
}
.input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e0e0e0;
  background: #fff;
}
.input-wrapper {
  position: relative;
  flex: 1;
}
textarea {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
  resize: none;
  overflow-y: auto;
  line-height: 1.4;
}
textarea:focus {
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
.empty-warning {
  position: absolute;
  bottom: -20px;
  left: 14px;
  font-size: 12px;
  color: #e53935;
  animation: fade-in 0.15s ease-in;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
