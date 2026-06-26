import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SavedQuery, QueryResult } from '../../../shared/types'

export interface QueryTab {
  key: string
  savedId: number | null
  name: string
  sqlText: string
  savedSqlText: string
  result: QueryResult | null
  executing: boolean
}

export const useQueryStore = defineStore('query', () => {
  const tabs = ref<QueryTab[]>([])
  const activeTabKey = ref<string | null>(null)
  const expandedTables = ref<Set<string>>(new Set())
  const initialized = ref(false)

  function newTab(name?: string, sql?: string): QueryTab {
    const key = `tab-${Date.now()}-${Math.random()}`
    const tab: QueryTab = {
      key,
      savedId: null,
      name: name ?? `Untitled Query ${tabs.value.length + 1}`,
      sqlText: sql ?? '',
      savedSqlText: sql ?? '',
      result: null,
      executing: false
    }
    tabs.value.push(tab)
    activeTabKey.value = key
    return tab
  }

  function loadFromSaved(queries: SavedQuery[]): void {
    const savedTabs = queries.map((q) => ({
      key: `saved-${q.id}`,
      savedId: q.id,
      name: q.name,
      sqlText: q.sqlText,
      savedSqlText: q.sqlText,
      result: null,
      executing: false
    }))
    // Preserve any unsaved tabs that were added before initialization
    // (e.g. from "Open in Query Editor" in DB Explorer before visiting this view).
    const pendingTabs = tabs.value.filter((t) => t.savedId === null)
    tabs.value = [...savedTabs, ...pendingTabs]
    if (tabs.value.length === 0) {
      newTab()
    } else if (!activeTabKey.value || !tabs.value.some((t) => t.key === activeTabKey.value)) {
      activeTabKey.value = tabs.value[0]?.key ?? null
    }
    initialized.value = true
  }

  function getActiveTab(): QueryTab | undefined {
    return tabs.value.find((t) => t.key === activeTabKey.value)
  }

  function setActiveTab(key: string): void {
    activeTabKey.value = key
  }

  function updateSql(key: string, sql: string): void {
    const tab = tabs.value.find((t) => t.key === key)
    if (tab) tab.sqlText = sql
  }

  function markSaved(key: string, savedId: number, name: string, sqlText: string): void {
    const tab = tabs.value.find((t) => t.key === key)
    if (tab) {
      tab.savedId = savedId
      tab.name = name
      tab.savedSqlText = sqlText
      tab.sqlText = sqlText
    }
  }

  function setResult(key: string, result: QueryResult): void {
    const tab = tabs.value.find((t) => t.key === key)
    if (tab) tab.result = result
  }

  function setExecuting(key: string, val: boolean): void {
    const tab = tabs.value.find((t) => t.key === key)
    if (tab) tab.executing = val
  }

  function closeTab(key: string): void {
    const idx = tabs.value.findIndex((t) => t.key === key)
    if (idx < 0) return
    tabs.value.splice(idx, 1)
    if (activeTabKey.value === key) {
      activeTabKey.value = tabs.value[Math.max(0, idx - 1)]?.key ?? null
      if (!activeTabKey.value && tabs.value.length === 0) newTab()
    }
  }

  function toggleTableExpanded(name: string): void {
    if (expandedTables.value.has(name)) expandedTables.value.delete(name)
    else expandedTables.value.add(name)
  }

  return {
    tabs,
    activeTabKey,
    expandedTables,
    initialized,
    newTab,
    loadFromSaved,
    getActiveTab,
    setActiveTab,
    updateSql,
    markSaved,
    setResult,
    setExecuting,
    closeTab,
    toggleTableExpanded
  }
})
