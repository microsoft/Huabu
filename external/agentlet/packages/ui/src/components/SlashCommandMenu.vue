<script setup lang="ts">
import { watch, ref, nextTick } from 'vue'
import type { AvailableCommand } from '../composables/useSlashCommandTypeahead'

const props = defineProps<{
  commands: AvailableCommand[]
  filter: string
  highlightIndex: number
}>()

const emit = defineEmits<{
  select: [command: AvailableCommand]
  hover: [index: number]
}>()

const listRef = ref<HTMLElement | null>(null)

// Keep highlighted row in view on keyboard navigation
watch(() => props.highlightIndex, async () => {
  await nextTick()
  if (!listRef.value) return
  const item = listRef.value.children[props.highlightIndex] as HTMLElement | undefined
  item?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div
    ref="listRef"
    class="slash-menu"
    role="listbox"
    aria-label="Slash commands"
  >
    <button
      v-for="(cmd, idx) in commands"
      :key="cmd.name"
      type="button"
      role="option"
      :aria-selected="idx === highlightIndex"
      class="slash-item"
      :class="{ active: idx === highlightIndex }"
      @mousedown.prevent
      @click="emit('select', cmd)"
      @mouseenter="emit('hover', idx)"
    >
      <div class="slash-item-header">
        <span class="slash-name">/{{ cmd.name }}</span>
        <span v-if="cmd.input?.hint" class="slash-hint">{{ cmd.input.hint }}</span>
      </div>
      <span v-if="cmd.description" class="slash-desc">{{ cmd.description }}</span>
    </button>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 6px;
  max-height: 240px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 50;
}

.slash-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.slash-item:hover,
.slash-item.active {
  background: #f0f4ff;
}

.slash-item-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
}

.slash-name {
  font-family: monospace;
  font-size: 13px;
  font-weight: 600;
  color: #1a1a1a;
}

.slash-hint {
  font-size: 11px;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-desc {
  font-size: 11px;
  color: #666;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
