import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SavedQuery, QueryDraft, PagedQueryResult, SortCriterion } from '../../../shared/types'

export interface QueryTab {
  key: string
  savedId: number | null
  name: string
  sqlText: string
  savedSqlText: string
  result: PagedQueryResult | null
  executing: boolean
  viewState: string | null
  sortCriteria: SortCriterion[]
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
      executing: false,
      viewState: null,
      sortCriteria: []
    }
    tabs.value.push(tab)
    activeTabKey.value = key
    return tab
  }

  /**
   * Restore tabs from auto-saved drafts on startup.
   * `savedQueries` is provided so we can look up the last-manually-saved sql text
   * for each tab that has a savedId (used to drive the dirty/unsaved indicator).
   */
  function loadFromDrafts(drafts: QueryDraft[], savedQueries: SavedQuery[]): void {
    const savedMap = new Map(savedQueries.map((q) => [q.id, q]))
    const draftTabs = drafts.map((d) => {
      const saved = d.savedId != null ? savedMap.get(d.savedId) : undefined
      return {
        key: d.tabKey,
        savedId: d.savedId,
        name: d.name,
        sqlText: d.sqlText,
        // savedSqlText is the last *manually* saved text; lets the dirty indicator work.
        // For unsaved tabs it stays '' so any content appears dirty.
        savedSqlText: saved?.sqlText ?? '',
        result: null,
        executing: false,
        viewState: d.viewState,
        sortCriteria: [] as SortCriterion[]
      }
    })
    const pendingTabs = tabs.value.filter((t) => t.savedId === null)
    tabs.value = [...draftTabs, ...pendingTabs]
    if (tabs.value.length === 0) {
      newTab()
    } else if (!activeTabKey.value || !tabs.value.some((t) => t.key === activeTabKey.value)) {
      activeTabKey.value = tabs.value[0]?.key ?? null
    }
    initialized.value = true
  }

  function loadFromSaved(queries: SavedQuery[]): void {
    const savedTabs = queries.map((q) => ({
      key: `saved-${q.id}`,
      savedId: q.id,
      name: q.name,
      sqlText: q.sqlText,
      savedSqlText: q.sqlText,
      result: null,
      executing: false,
      viewState: q.viewState,
      sortCriteria: [] as SortCriterion[]
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

  function setResult(key: string, result: PagedQueryResult): void {
    const tab = tabs.value.find((t) => t.key === key)
    if (tab) {
      tab.result = result
    }
  }

  function updateResultPage(key: string, rows: unknown[][], offset: number): void {
    const tab = tabs.value.find((t) => t.key === key)
    if (tab?.result) {
      tab.result = { ...tab.result, rows, offset }
    }
  }

  function updateSortCriteria(key: string, criteria: SortCriterion[]): void {
    const tab = tabs.value.find((t) => t.key === key)
    if (tab) {
      tab.sortCriteria = criteria
    }
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
    loadFromDrafts,
    loadFromSaved,
    getActiveTab,
    setActiveTab,
    updateSql,
    markSaved,
    setResult,
    updateResultPage,
    updateSortCriteria,
    setExecuting,
    closeTab,
    toggleTableExpanded
  }
})
