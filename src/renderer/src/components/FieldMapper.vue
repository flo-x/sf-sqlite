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
          </tr>
        </thead>
        <tbody>
          <tr v-for="{ m, origIdx } in visibleMappings" :key="origIdx" :class="{ excluded: m.excluded }">
            <td>
              <input type="checkbox" :checked="!m.excluded" @change="toggleExcluded(origIdx, $event)" />
            </td>
            <td :class="{ 'text-muted': m.excluded }">
              <span class="mono">{{ m.sqlCol }}</span>
            </td>
            <td style="text-align:center; color: var(--text-muted);">→</td>
            <td class="sf-field-cell">
              <select v-model="m.sfField" :disabled="m.excluded" @change="onSfFieldChange(origIdx)">
                <option value="">— skip —</option>
                <option v-for="f in sfFields" :key="f.name" :value="f.name">{{ f.name }} ({{ f.type }})</option>
              </select>
              <template v-if="!m.excluded && isReferenceField(m.sfField)">
                <div class="ext-id-row">
                  <label class="ext-id-toggle">
                    <input
                      type="checkbox"
                      :checked="!!m.useExternalId"
                      @change="toggleUseExternalId(origIdx, $event)"
                    />
                    via Ext. ID
                  </label>
                  <span
                    class="info-icon-wrap"
                    tabindex="0"
                    @mouseenter="showInfo($event)"
                    @mouseleave="hideInfo"
                    @focus="showInfo($event)"
                    @blur="hideInfo"
                  >ⓘ</span>
                </div>
                <select
                  v-if="m.useExternalId"
                  :value="m.externalIdFieldName ?? ''"
                  :disabled="!relExtIdFields(m.sfField).length"
                  class="ext-id-field-select"
                  @change="onExtIdFieldChange(origIdx, $event)"
                >
                  <option value="">— select External ID field —</option>
                  <option v-for="f in relExtIdFields(m.sfField)" :key="f.name" :value="f.name">
                    {{ f.name }}
                  </option>
                </select>
                <span v-if="m.useExternalId && isLoadingRelObject(m.sfField)" class="ext-id-loading">loading…</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="infoVisible" class="fm-info-tooltip" :style="infoStyle">
      Resolve the related record by a unique <strong>External ID</strong> on the target object
      instead of a Salesforce record ID. Useful when your data contains business keys rather
      than Salesforce IDs.
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, type CSSProperties } from 'vue'
import type { FieldMapping, FieldDescriptor } from '../../../shared/types'

const props = defineProps<{
  modelValue: FieldMapping[]
  sfFields: FieldDescriptor[]
}>()

const emit = defineEmits<{ 'update:modelValue': [v: FieldMapping[]] }>()

const mappings = ref<FieldMapping[]>(props.modelValue)
watch(
  () => props.modelValue,
  (v) => { mappings.value = v }
)

const showMapped = ref(true)
const showUnmapped = ref(true)

const visibleMappings = computed(() =>
  mappings.value
    .map((m, origIdx) => ({ m, origIdx }))
    .filter(({ m }) => (m.sfField ? showMapped.value : showUnmapped.value))
)

// ── Reference-field helpers ───────────────────────────────────────────────────

/** Fields on related objects, keyed by the primary SF field name (e.g. "AccountId"). */
const relObjectFieldsMap = ref<Map<string, FieldDescriptor[]>>(new Map())
const loadingRelObjects = ref<Set<string>>(new Set())

function getDescriptor(sfFieldName: string): FieldDescriptor | undefined {
  return props.sfFields.find((f) => f.name === sfFieldName)
}

function isReferenceField(sfFieldName: string): boolean {
  return getDescriptor(sfFieldName)?.type === 'reference'
}

function isLoadingRelObject(sfFieldName: string): boolean {
  return loadingRelObjects.value.has(sfFieldName)
}

/** External-ID-capable fields on the first related object for the given SF lookup field. */
function relExtIdFields(sfFieldName: string): FieldDescriptor[] {
  const cached = relObjectFieldsMap.value.get(sfFieldName)
  if (!cached) return []
  // id, idLookup, externalId and Name are all valid targets for relationship-by-ext-id
  return cached.filter((f) => f.externalId || f.idLookup || f.name === 'Name' || f.name === 'Id')
}

async function ensureRelObjectFields(sfFieldName: string): Promise<void> {
  if (relObjectFieldsMap.value.has(sfFieldName) || loadingRelObjects.value.has(sfFieldName)) return
  const descriptor = getDescriptor(sfFieldName)
  const relObject = descriptor?.referenceTo?.[0]
  if (!relObject) return
  loadingRelObjects.value = new Set([...loadingRelObjects.value, sfFieldName])
  try {
    const fields = await window.api.describeObject(relObject)
    const next = new Map(relObjectFieldsMap.value)
    next.set(sfFieldName, fields.fields)
    relObjectFieldsMap.value = next
  } catch (_e) {
    // silently ignore; the select will stay empty
  } finally {
    const next = new Set(loadingRelObjects.value)
    next.delete(sfFieldName)
    loadingRelObjects.value = next
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

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

function toggleExcluded(idx: number, event: Event): void {
  mappings.value[idx].excluded = !(event.target as HTMLInputElement).checked
  emit('update:modelValue', [...mappings.value])
}

function onSfFieldChange(idx: number): void {
  // Clear ext-ID settings whenever the SF field changes
  const m = mappings.value[idx]
  m.useExternalId = false
  m.relationshipName = undefined
  m.externalIdFieldName = undefined
  // Pre-fetch related object fields if this is a reference field
  if (isReferenceField(m.sfField)) {
    ensureRelObjectFields(m.sfField)
  }
  emit('update:modelValue', [...mappings.value])
}

function toggleUseExternalId(idx: number, event: Event): void {
  const m = mappings.value[idx]
  const checked = (event.target as HTMLInputElement).checked
  m.useExternalId = checked
  if (checked) {
    const descriptor = getDescriptor(m.sfField)
    m.relationshipName = descriptor?.relationshipName ?? undefined
    m.externalIdFieldName = undefined
    ensureRelObjectFields(m.sfField)
  } else {
    m.relationshipName = undefined
    m.externalIdFieldName = undefined
  }
  emit('update:modelValue', [...mappings.value])
}

function onExtIdFieldChange(idx: number, event: Event): void {
  mappings.value[idx].externalIdFieldName = (event.target as HTMLSelectElement).value || undefined
  emit('update:modelValue', [...mappings.value])
}

// ── Info tooltip (teleported to body to escape overflow:auto clipping) ────────

const infoVisible = ref(false)
const infoStyle = ref<CSSProperties>({})

function showInfo(event: MouseEvent | FocusEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  infoVisible.value = true
  infoStyle.value = {
    position: 'fixed',
    bottom: `${window.innerHeight - rect.top + 6}px`,
    left: `${rect.left + rect.width / 2}px`,
    transform: 'translateX(-50%)',
  }
}

function hideInfo(): void {
  infoVisible.value = false
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
.sf-field-cell { display: flex; flex-direction: column; gap: 3px; padding: 2px 6px; }
.sf-field-cell select { width: 100%; padding: 2px 6px; font-size: 12px; }
.ext-id-row { display: flex; align-items: center; gap: 6px; }
.ext-id-toggle { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); cursor: pointer; user-select: none; }
.ext-id-toggle input { cursor: pointer; }
.ext-id-field-select { width: 100%; font-size: 12px; padding: 2px 6px; }
.ext-id-loading { font-size: 11px; color: var(--text-muted); font-style: italic; }

.info-icon-wrap {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  color: var(--text-muted);
  opacity: 0.7;
  cursor: default;
  outline: none;
  transition: opacity 0.15s;
}
.info-icon-wrap:hover, .info-icon-wrap:focus { opacity: 1; }
</style>

<style>
.fm-info-tooltip {
  max-width: 320px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--text);
  pointer-events: none;
  z-index: 9999;
  white-space: normal;
}
</style>
