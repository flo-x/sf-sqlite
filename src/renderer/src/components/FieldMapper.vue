<template>
  <div class="field-mapper">
    <div class="fm-toolbar">
      <span class="section-title" style="padding:0;">Field Mapping</span>
      <button class="btn btn-secondary btn-sm" @click="autoMap">Auto-map</button>
      <button class="btn btn-secondary btn-sm" @click="skipUnknown">Skip unknown</button>
      <label class="fm-filter-label">
        <input type="checkbox" v-model="showMapped" /> show mapped
      </label>
      <label class="fm-filter-label">
        <input type="checkbox" v-model="showUnmapped" /> show unmapped
      </label>
    </div>
    <div class="fm-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:36px;">Inc.</th>
            <th>SQL Column</th>
            <th style="width:32px;"></th>
            <th>Salesforce Field</th>
            <th v-if="showKey" style="width:52px;">Key?</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="{ m, origIdx } in visibleMappings" :key="origIdx" :class="{ excluded: m.excluded }">
            <td>
              <input type="checkbox" :checked="!m.excluded" @change="m.excluded = !($event.target as HTMLInputElement).checked" />
            </td>
            <td :class="{ 'text-muted': m.excluded }">
              <span class="mono">{{ m.sqlCol }}</span>
            </td>
            <td style="text-align:center; color: var(--text-muted);">→</td>
            <td>
              <select v-model="m.sfField" :disabled="m.excluded" @change="onMappingChange">
                <option value="">— skip —</option>
                <option v-for="f in sfFields" :key="f.name" :value="f.name">{{ f.name }} ({{ f.type }})</option>
              </select>
            </td>
            <td v-if="showKey">
              <input
                type="radio"
                :name="'keyfield'"
                :checked="m.isKey"
                :disabled="m.excluded || !m.sfField"
                @change="setKey(origIdx)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { FieldMapping, FieldDescriptor } from '../../../shared/types'

const props = defineProps<{
  modelValue: FieldMapping[]
  sfFields: FieldDescriptor[]
  showKey?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [v: FieldMapping[]] }>()

// Use a ref so the template reacts when the parent replaces the entire array.
const mappings = ref<FieldMapping[]>(props.modelValue)
watch(
  () => props.modelValue,
  (v) => { mappings.value = v }
)

const showMapped = ref(true)
const showUnmapped = ref(true)

// A mapping is "mapped" when a Salesforce field has been chosen for it.
const visibleMappings = computed(() =>
  mappings.value
    .map((m, origIdx) => ({ m, origIdx }))
    .filter(({ m }) => (m.sfField ? showMapped.value : showUnmapped.value))
)

function autoMap(): void {
  for (const m of mappings.value) {
    const match = props.sfFields.find((f) => f.name.toLowerCase() === m.sqlCol.toLowerCase())
    if (match) {
      m.sfField = match.name
      m.excluded = false
    } else {
      m.excluded = true
    }
  }
}

function skipUnknown(): void {
  const sfNames = new Set(props.sfFields.map((f) => f.name.toLowerCase()))
  for (const m of mappings.value) {
    if (!sfNames.has(m.sqlCol.toLowerCase())) m.excluded = true
  }
}

function setKey(idx: number): void {
  for (let i = 0; i < mappings.value.length; i++) mappings.value[i].isKey = i === idx
}

function onMappingChange(): void {
  emit('update:modelValue', [...mappings.value])
}
</script>

<style scoped>
.field-mapper { display: flex; flex-direction: column; gap: 8px; }
.fm-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fm-filter-label { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); cursor: pointer; user-select: none; }
.fm-filter-label input { cursor: pointer; }
.fm-table-wrap { overflow: auto; max-height: 320px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
tr.excluded td { opacity: 0.45; text-decoration: line-through; }
tr.excluded td:first-child { opacity: 1; text-decoration: none; }
.mono { font-family: monospace; font-size: 12px; }
.text-muted { color: var(--text-muted); }
</style>
