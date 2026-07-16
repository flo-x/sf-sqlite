<template>
  <div class="sfl">
    <!-- Standard fields -->
    <div class="sfl-toolbar">
      <input v-model="search" type="text" placeholder="Filter fields…" style="flex:1;" />
      <button class="btn btn-ghost btn-sm" @click="toggleAll(true)">All</button>
      <button class="btn btn-ghost btn-sm" @click="toggleAll(false)">None</button>
      <button class="btn btn-ghost btn-sm" :class="{ 'sfl-btn-active': systemFieldsActive }" @click="toggleSystemFields">System fields</button>
    </div>
    <div class="sfl-list">
      <label v-for="f in filtered" :key="f.name" class="sfl-item">
        <input type="checkbox" :value="f.name" v-model="selected" />
        <span class="sfl-badge" :class="typeBadgeClass(f.type)">{{ shortType(f.type) }}</span>
        <span class="sfl-name">{{ f.name }}</span>
        <span class="sfl-label">{{ f.label }}</span>
      </label>
    </div>

    <!-- Custom expressions -->
    <div class="sfl-custom-section">
      <div class="sfl-custom-title">Custom SELECT items</div>
      <div v-if="customExprs.length" class="sfl-custom-list">
        <div v-for="(expr, i) in customExprs" :key="i" class="sfl-custom-item">
          <span class="sfl-badge sfl-badge-custom">fx</span>
          <span class="sfl-name sfl-custom-expr" :title="expr">{{ expr }}</span>
          <div class="sfl-custom-actions">
            <button class="sfl-icon-btn" :disabled="i === 0" @click="moveExpr(i, -1)" title="Move up">↑</button>
            <button class="sfl-icon-btn" :disabled="i === customExprs.length - 1" @click="moveExpr(i, 1)" title="Move down">↓</button>
            <button class="sfl-icon-btn sfl-icon-btn-danger" @click="removeExpr(i)" title="Remove">✕</button>
          </div>
        </div>
      </div>
      <div class="sfl-custom-add">
        <input
          v-model="newExpr"
          type="text"
          placeholder="e.g. Account.Owner.Name"
          class="sfl-custom-input"
          @keydown.enter.prevent="addExpr"
        />
        <button class="btn btn-ghost btn-sm" :disabled="!newExpr.trim()" @click="addExpr">+ Add</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { FieldDescriptor } from '../../../shared/types'

const props = defineProps<{
  fields: FieldDescriptor[]
  modelValue: string[]         // standard field names (checkboxes)
  customExpressions: string[]  // custom SOQL SELECT items
}>()
const emit = defineEmits<{
  'update:modelValue': [v: string[]]
  'update:customExpressions': [v: string[]]
}>()

const search = ref('')
const newExpr = ref('')

// Use computed getter/setter to avoid watcher round-trips that caused sluggish checkbox response
const selected = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})
const customExprs = computed({
  get: () => props.customExpressions,
  set: (v) => emit('update:customExpressions', v)
})

const filtered = computed(() => {
  const q = search.value.toLowerCase()
  return q ? props.fields.filter((f) => f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q)) : props.fields
})

const SYSTEM_FIELD_LABELS = new Set([
  'deleted', 'created date', 'created by id', 'last modified date',
  'last modified by id', 'system modstamp', 'may edit', 'is locked'
])

const systemFields = computed(() =>
  props.fields.filter((f) => SYSTEM_FIELD_LABELS.has(f.label.toLowerCase()))
)

const systemFieldsActive = computed(() =>
  systemFields.value.some((f) => selected.value.includes(f.name))
)

function toggleAll(on: boolean): void {
  selected.value = on ? props.fields.map((f) => f.name) : []
}

function toggleSystemFields(): void {
  const sysNames = systemFields.value.map((f) => f.name)
  if (systemFieldsActive.value) {
    const remove = new Set(sysNames)
    selected.value = selected.value.filter((n) => !remove.has(n))
  } else {
    const current = new Set(selected.value)
    for (const name of sysNames) {
      current.add(name)
    }
    selected.value = [...current]
  }
}

function addExpr(): void {
  const expr = newExpr.value.trim()
  if (!expr || customExprs.value.includes(expr)) return
  customExprs.value = [...customExprs.value, expr]
  newExpr.value = ''
}

function removeExpr(i: number): void {
  customExprs.value = customExprs.value.filter((_, idx) => idx !== i)
}

function moveExpr(i: number, dir: -1 | 1): void {
  const arr = [...customExprs.value]
  const j = i + dir
  if (j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  customExprs.value = arr
}

function shortType(t: string): string {
  if (['double', 'currency', 'percent', 'int'].includes(t)) return '#'
  if (t === 'boolean') return 'B'
  if (['date', 'datetime'].includes(t)) return 'D'
  if (t === 'reference') return 'R'
  return 'T'
}

function typeBadgeClass(t: string): string {
  if (['double', 'currency', 'percent', 'int'].includes(t)) return 'badge-blue'
  if (t === 'boolean') return 'badge-purple'
  if (['date', 'datetime'].includes(t)) return 'badge-amber'
  if (t === 'reference') return 'badge-red'
  return 'badge-gray'
}
</script>

<style scoped>
.sfl { display: flex; flex-direction: column; gap: 8px; }
.sfl-toolbar { display: flex; align-items: center; gap: 6px; }
.sfl-btn-active { background: color-mix(in srgb, var(--primary) 12%, transparent) !important; color: var(--primary) !important; }
.sfl-list { max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.sfl-item { display: flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
.sfl-item:hover { background: var(--surface2); }
.sfl-badge { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; font-size: 10px; font-weight: 700; flex-shrink: 0; }
.sfl-name { font-weight: 500; flex: 1; }
.sfl-label { font-size: 12px; color: var(--text-muted); }

/* Custom expressions */
.sfl-custom-section { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 8px; }
.sfl-custom-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.sfl-custom-list { border: 1px solid var(--border); border-radius: var(--radius-sm); }
.sfl-custom-item { display: flex; align-items: center; gap: 5px; padding: 2px 8px; font-size: 12px; cursor: default; color: var(--text-muted); }
.sfl-custom-item:hover { background: var(--surface2); }
.sfl-badge-custom { background: color-mix(in srgb, var(--primary) 15%, transparent); color: var(--primary); font-size: 9px; }
.sfl-custom-expr { }
.sfl-custom-actions { display: flex; gap: 2px; flex-shrink: 0; margin-left: auto; }
.sfl-icon-btn { background: none; border: none; cursor: pointer; font-size: 11px; color: var(--text-muted); padding: 1px 4px; border-radius: 3px; line-height: 1; }
.sfl-icon-btn:hover:not(:disabled) { background: var(--border); color: var(--text); }
.sfl-icon-btn:disabled { opacity: 0.3; cursor: default; }
.sfl-icon-btn-danger:hover:not(:disabled) { background: var(--danger); color: #fff; }
.sfl-custom-add { display: flex; gap: 6px; }
.sfl-custom-input { flex: 1; font-size: 12px; }
</style>
