import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { OrgInfo, TableInfo, SObjectSummary } from '../../../shared/types'

export const useConnectionStore = defineStore('connection', () => {
  const sfOrg = ref<OrgInfo | null>(null)
  const dbPath = ref<string | null>(null)
  const dbTables = ref<TableInfo[]>([])
  const sfObjects = ref<SObjectSummary[]>([])
  const sfConnecting = ref(false)
  const dbConnecting = ref(false)
  const sfAutoConnecting = ref(false)     // true while background auto-connect is running
  const sfAutoConnectError = ref<{ username: string; message: string } | null>(null)

  const sfConnected = computed(() => sfOrg.value !== null)
  const dbConnected = computed(() => dbPath.value !== null)
  const bothConnected = computed(() => sfConnected.value && dbConnected.value)

  async function connectSF(creds: Parameters<typeof window.api.connectPassword>[0]): Promise<void> {
    sfConnecting.value = true
    try {
      sfOrg.value = await window.api.connectPassword(creds)
      sfObjects.value = []
    } finally {
      sfConnecting.value = false
    }
  }

  async function connectOAuth(clientId: string, loginUrl: string): Promise<void> {
    sfConnecting.value = true
    try {
      sfOrg.value = await window.api.connectOAuth(clientId, loginUrl)
      sfObjects.value = []
    } finally {
      sfConnecting.value = false
    }
  }

  async function connectSFCli(username: string): Promise<void> {
    sfConnecting.value = true
    try {
      sfOrg.value = await window.api.connectCliOrg(username)
      sfObjects.value = []
      sfAutoConnectError.value = null   // clear error if the user connects manually
    } finally {
      sfConnecting.value = false
    }
  }

  async function disconnectSF(): Promise<void> {
    await window.api.disconnectSalesforce()
    sfOrg.value = null
    sfObjects.value = []
  }

  async function openDatabase(filePath?: string): Promise<boolean> {
    dbConnecting.value = true
    try {
      const result = await window.api.openDatabase(filePath)
      if (!result) return false
      dbPath.value = result.path
      sfAutoConnectError.value = null   // clear any prior error when re-opening a DB
      await refreshDbInfo()
      return true
    } finally {
      dbConnecting.value = false
    }
  }

  async function createDatabase(): Promise<boolean> {
    dbConnecting.value = true
    try {
      const result = await window.api.openNewDatabase()
      if (!result) return false
      dbPath.value = result.path
      sfAutoConnectError.value = null
      await refreshDbInfo()
      return true
    } finally {
      dbConnecting.value = false
    }
  }

  async function refreshDbInfo(): Promise<void> {
    if (!dbConnected.value) return
    dbTables.value = await window.api.getDatabaseInfo()
  }

  async function loadSFObjects(): Promise<void> {
    if (!sfConnected.value) return
    if (sfObjects.value.length > 0) return
    sfObjects.value = await window.api.listObjects()
  }

  async function refreshSFObjects(): Promise<void> {
    if (!sfConnected.value) return
    sfObjects.value = []
    sfObjects.value = await window.api.listObjects()
  }

  /**
   * Called once on renderer startup to recover state after an HMR reload or
   * a suspend/resume cycle that caused the renderer to reset while the main
   * process (and its connections) stayed alive.
   */
  async function syncFromMain(): Promise<void> {
    const status = await window.api.getConnectionStatus()
    if (status.sfOrg && !sfOrg.value) {
      sfOrg.value = status.sfOrg
    }
    if (status.dbPath && !dbPath.value) {
      dbPath.value = status.dbPath
      await refreshDbInfo()
    }
  }

  // Background SF auto-connect events from the main process.
  window.api.onSfAutoConnectStart(() => {
    sfAutoConnecting.value = true
    sfAutoConnectError.value = null
  })

  window.api.onSfAutoConnected((org) => {
    sfAutoConnecting.value = false
    if (!sfOrg.value) {
      sfOrg.value = org
      sfObjects.value = []
    }
  })

  window.api.onSfAutoConnectFailed((info) => {
    sfAutoConnecting.value = false
    sfAutoConnectError.value = info
  })

  return {
    sfOrg,
    dbPath,
    dbTables,
    sfObjects,
    sfConnecting,
    dbConnecting,
    sfAutoConnecting,
    sfAutoConnectError,
    sfConnected,
    dbConnected,
    bothConnected,
    connectSF,
    connectOAuth,
    connectSFCli,
    disconnectSF,
    openDatabase,
    createDatabase,
    refreshDbInfo,
    loadSFObjects,
    refreshSFObjects,
    syncFromMain
  }
})
