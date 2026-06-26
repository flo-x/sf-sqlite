<template>
  <div class="obj-picker" ref="pickerEl">
    <div class="obj-input-row">
      <input
        v-model="search"
        type="text"
        placeholder="Search objects..."
        class="obj-search"
        autocomplete="off"
        @focus="openDropdown"
        @input="openDropdown"
        @keydown.down.prevent="moveHighlight(1)"
        @keydown.up.prevent="moveHighlight(-1)"
        @keydown.enter.prevent="confirmHighlighted"
        @keydown.escape="close"
        @keydown.tab="close"
      />
      <button class="obj-refresh-btn" :disabled="refreshing" title="Refresh object list" @click.prevent="emit('refresh')">
        <span v-if="refreshing" class="spinner" style="width:11px;height:11px;border-width:2px;"></span>
        <span v-else>↻</span>
      </button>
    </div>
    <div v-if="open && filtered.length" class="obj-dropdown" ref="dropdownEl">
      <div
        v-for="(obj, i) in filtered.slice(0, 100)"
        :key="obj.name"
        class="obj-item"
        :class="{ selected: modelValue === obj.name, highlighted: i === highlightIdx }"
        :ref="(el) => { if (i === highlightIdx) highlightedEl = el as HTMLElement }"
        @mousedown.prevent="select(obj.name)"
        @mousemove="highlightIdx = i"
      >
        <div class="obj-name">{{ obj.name }}</div>
        <div class="obj-label">{{ obj.label }}</div>
      </div>
    </div>
    <div v-if="open && search && !filtered.length" class="obj-dropdown">
      <div class="obj-empty">No objects match "{{ search }}"</div>
    </div>
  </div>
</template>


<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { SObjectSummary } from '../../../shared/types'

const props = defineProps<{ modelValue: string; objects: SObjectSummary[]; refreshing?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: string]; refresh: [] }>()

const search = ref(props.modelValue)
const open = ref(false)
const highlightIdx = ref(-1)
const pickerEl = ref<HTMLElement>()
const dropdownEl = ref<HTMLElement>()
let highlightedEl: HTMLElement | null = null

watch(() => props.modelValue, (v) => {
  if (v !== search.value) search.value = v
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.objects
  return props.objects.filter(
    (o) => o.name.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)
  )
})

watch(filtered, () => {
  // Reset highlight when results change
  highlightIdx.value = filtered.value.findIndex((o) => o.name === props.modelValue)
})

function openDropdown(): void {
  open.value = true
  // Pre-highlight the currently selected item
  if (highlightIdx.value < 0) {
    highlightIdx.value = filtered.value.findIndex((o) => o.name === props.modelValue)
  }
}

function close(): void {
  open.value = false
  highlightIdx.value = -1
}

function select(name: string): void {
  emit('update:modelValue', name)
  search.value = name
  close()
}

function confirmHighlighted(): void {
  if (open.value && highlightIdx.value >= 0 && filtered.value[highlightIdx.value]) {
    select(filtered.value[highlightIdx.value].name)
  }
}

function moveHighlight(delta: number): void {
  if (!open.value) {
    openDropdown()
    return
  }
  const max = Math.min(filtered.value.length, 100) - 1
  highlightIdx.value = Math.max(0, Math.min(max, highlightIdx.value + delta))
  // Scroll highlighted item into view
  setTimeout(() => {
    highlightedEl?.scrollIntoView({ block: 'nearest' })
  })
}

// Close when clicking outside
function onDocClick(e: MouseEvent): void {
  if (pickerEl.value && !pickerEl.value.contains(e.target as Node)) {
    close()
  }
}
document.addEventListener('mousedown', onDocClick)
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))
</script>

<style scoped>
.obj-picker { position: relative; }
.obj-input-row { display: flex; gap: 4px; }
.obj-search { flex: 1; min-width: 0; }
.obj-refresh-btn { flex-shrink: 0; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); width: 28px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }
.obj-refresh-btn:hover:not(:disabled) { background: var(--border); color: var(--text); }
.obj-refresh-btn:disabled { opacity: 0.5; cursor: default; }
.obj-dropdown {
  position: absolute;
  z-index: 200;
  left: 0;
  right: 0;
  top: calc(100% + 2px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  max-height: 280px;
  overflow-y: auto;
  box-shadow: var(--shadow-md);
}
.obj-item { padding: 7px 12px; cursor: pointer; }
.obj-item:hover { background: var(--surface2); }
.obj-item.selected { font-weight: 600; }
.obj-item.highlighted { background: var(--primary); color: #fff; }
.obj-item.highlighted .obj-label { color: rgba(255,255,255,0.75); }
.obj-name { font-size: 13px; }
.obj-label { font-size: 12px; color: var(--text-muted); }
.obj-empty { padding: 12px; text-align: center; color: var(--text-muted); font-size: 13px; }
</style>
