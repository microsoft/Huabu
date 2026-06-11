/**
 * Vue composable for slash-command typeahead in the chat input.
 *
 * Ported from Sediment's React hook (useSlashCommandTypeahead.ts).
 * Handles:
 *  - Activation parsing (does `/<token>` apply at the current caret?)
 *  - Keyboard interception (Arrows / Tab / Enter / Esc)
 *  - Insertion of the chosen command back into the input
 */

import { ref, computed, watch, type Ref } from 'vue'

export interface AvailableCommand {
  name: string
  description?: string
  input?: { hint?: string }
}

export interface SlashTypeaheadState {
  /** Whether the menu should be visible */
  isOpen: boolean
  /** Text typed after the leading `/` (empty = show all) */
  filter: string
  /** Filtered list of matching commands */
  filtered: AvailableCommand[]
  /** Index of the highlighted item */
  highlightIndex: number
}

export function useSlashCommandTypeahead(
  inputValue: Ref<string>,
  commands: Ref<AvailableCommand[]>,
) {
  const caretPos = ref(0)
  const dismissedFor = ref<string | null>(null)
  const highlightIndex = ref(0)

  /** Whether the user intends to open the slash menu */
  const wantsMenu = computed(() => {
    const val = inputValue.value
    if (!val.startsWith('/')) return false
    const firstSpace = val.search(/\s/)
    const tokenEnd = firstSpace === -1 ? val.length : firstSpace
    if (caretPos.value > tokenEnd) return false
    const filter = val.slice(1, tokenEnd)
    if (filter.length > 0 && !/^[a-zA-Z]/.test(filter)) return false
    if (dismissedFor.value === filter) return false
    return true
  })

  /** The current filter text (after the `/`) */
  const filter = computed(() => {
    const val = inputValue.value
    const firstSpace = val.search(/\s/)
    const tokenEnd = firstSpace === -1 ? val.length : firstSpace
    return val.slice(1, tokenEnd)
  })

  /** Filtered commands matching the current filter */
  const filtered = computed(() => {
    if (!wantsMenu.value || commands.value.length === 0) return []
    const needle = filter.value.toLowerCase()
    if (!needle) return commands.value
    const startsWith: AvailableCommand[] = []
    const includes: AvailableCommand[] = []
    for (const cmd of commands.value) {
      const name = cmd.name.toLowerCase()
      if (name.startsWith(needle)) startsWith.push(cmd)
      else if (name.includes(needle)) includes.push(cmd)
    }
    return [...startsWith, ...includes]
  })

  /** Whether the menu popup should show */
  const isOpen = computed(() => wantsMenu.value && filtered.value.length > 0)

  // Clamp highlight when filtered list shrinks
  watch(filtered, (list) => {
    if (highlightIndex.value >= list.length) {
      highlightIndex.value = Math.max(list.length - 1, 0)
    }
  })

  // Clear dismiss when user changes the slash token
  watch(inputValue, (val) => {
    if (dismissedFor.value !== null && !val.startsWith(`/${dismissedFor.value}`)) {
      dismissedFor.value = null
    }
  })

  function syncCaret(pos: number) {
    caretPos.value = pos
  }

  function moveHighlight(delta: 1 | -1) {
    const len = filtered.value.length
    if (len === 0) return
    highlightIndex.value = (highlightIndex.value + delta + len) % len
  }

  function dismiss() {
    dismissedFor.value = filter.value
  }

  function accept(command: AvailableCommand): string {
    const val = inputValue.value
    const firstSpace = val.search(/\s/)
    const tokenEnd = firstSpace === -1 ? val.length : firstSpace
    const rest = val.slice(tokenEnd).replace(/^\s+/, '')
    const replacement = `/${command.name} `
    dismissedFor.value = null
    return replacement + rest
  }

  /**
   * Handle keydown in the input. Returns true if the event was consumed.
   */
  function handleKeyDown(e: KeyboardEvent): boolean {
    if (!isOpen.value) return false

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveHighlight(1)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveHighlight(-1)
      return true
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      const active = filtered.value[highlightIndex.value]
      if (active) {
        e.preventDefault()
        inputValue.value = accept(active)
        return true
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      dismiss()
      return true
    }
    return false
  }

  return {
    isOpen,
    filter,
    filtered,
    highlightIndex,
    syncCaret,
    handleKeyDown,
    accept,
    dismiss,
    moveHighlight,
  }
}
