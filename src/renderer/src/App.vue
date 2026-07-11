<template>
  <div class="app-layout">
    <!-- Full-width header: drag zone + status bar -->
    <header class="titlebar">
      <div class="titlebar-drag"></div>
      <div class="titlebar-status">
        <span class="status-dot" :class="conn.dbConnected ? 'green' : 'red'"></span>
        <span v-if="conn.dbConnected" style="font-family: monospace; font-size:12px;">{{ conn.dbPath }}</span>
        <span v-else style="color: var(--text-muted)">No database open</span>
      </div>
      <div class="titlebar-status" style="margin-left: auto;">
        <span class="status-dot" :class="conn.sfConnected ? 'green' : 'red'"></span>
        <span v-if="conn.sfConnected">{{ conn.sfOrg?.username }} ({{ conn.sfOrg?.instanceUrl }})</span>
        <span v-else style="color: var(--text-muted)">Not connected to Salesforce</span>
      </div>
    </header>

    <!-- Update banner — only visible when an update is available or downloading -->
    <div v-if="updateState !== 'idle'" class="update-banner">
      <template v-if="updateState === 'available'">
        <span>Version {{ updateVersion }} is available</span>
        <button class="update-btn" @click="startDownload">
          {{ updateManual ? 'Download manually' : 'Download' }}
        </button>
      </template>
      <template v-else-if="updateState === 'downloading'">
        <span>Downloading update… {{ updatePercent }}%</span>
        <div class="update-progress-track">
          <div class="update-progress-fill" :style="{ width: updatePercent + '%' }"></div>
        </div>
      </template>
      <template v-else-if="updateState === 'ready'">
        <span>Update ready — restart to apply</span>
        <button class="update-btn update-btn-primary" @click="installNow">Restart &amp; Install</button>
        <button class="update-btn update-btn-ghost" @click="updateState = 'idle'">Later</button>
      </template>
    </div>

    <div class="app-body">
    <!-- Sidebar -->
    <nav class="sidebar">
      <div class="sidebar-logo">SF</div>
      <NavButton to="/query" tooltip="Query Editor" :disabled="!conn.dbConnected">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
      </NavButton>
      <NavButton to="/extract" tooltip="SF → SQLite" :disabled="!conn.bothConnected" :running="extractRunning">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
          <rect x="3" y="2" width="18" height="4" rx="1" fill="currentColor" opacity="0.3"/>
          <rect x="3" y="18" width="18" height="4" rx="1" fill="currentColor" opacity="0.3"/>
        </svg>
      </NavButton>
      <NavButton to="/writeback" tooltip="SQLite → SF" :disabled="!conn.bothConnected" :running="writebackRunning">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
          <rect x="3" y="2" width="18" height="4" rx="1" fill="currentColor" opacity="0.3"/>
          <rect x="3" y="18" width="18" height="4" rx="1" fill="currentColor" opacity="0.3"/>
        </svg>
      </NavButton>
      <NavButton to="/explorer" tooltip="DB Explorer" :disabled="!conn.dbConnected">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
      </NavButton>
      <NavButton to="/scripts" tooltip="JS Scripts" :disabled="!conn.dbConnected" :running="scriptRunning">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M9 9l-3 3 3 3"/><path d="M15 9l3 3-3 3"/>
          <line x1="12" y1="7" x2="12" y2="17" stroke-dasharray="2 2"/>
        </svg>
      </NavButton>
      <NavButton to="/connections" tooltip="Connections">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><circle cx="5" cy="19" r="3"/>
          <line x1="12" y1="8" x2="12" y2="14"/><line x1="12" y1="14" x2="5" y2="19"/><line x1="12" y1="14" x2="19" y2="19"/>
        </svg>
      </NavButton>
      <div style="flex:1" />
      <NavButton to="/settings" tooltip="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
        </svg>
      </NavButton>
    </nav>

    <div class="main-area">
      <!-- Router view — keep-alive preserves component state (edit buffers, editors,
           log history) across route changes without persisting to the backend. -->
      <div class="view-content">
        <router-view v-slot="{ Component }">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </div>
    </div>
    </div><!-- end app-body -->
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useConnectionStore } from './stores/connection'
import { useJobStore } from './stores/job'
import NavButton from './components/NavButton.vue'

const conn = useConnectionStore()
const jobs = useJobStore()

const extractRunning = computed(() =>
  [...jobs.activeJobs.values()].some((j) => j.type === 'extract' && j.status === 'running')
)
const writebackRunning = computed(() =>
  [...jobs.activeJobs.values()].some((j) => j.type === 'writeback' && j.status === 'running')
)
const scriptRunning = computed(() => jobs.scriptRunning)

type UpdateState = 'idle' | 'available' | 'downloading' | 'ready'
const updateState = ref<UpdateState>('idle')
const updateVersion = ref('')
const updatePercent = ref(0)
const updateManual = ref(false)

async function startDownload(): Promise<void> {
  if (updateManual.value) {
    await window.api.openReleasesPage()
    return
  }
  updateState.value = 'downloading'
  await window.api.downloadUpdate()
}

function installNow(): void {
  window.api.installUpdate()
}

onMounted(async () => {
  // Re-hydrate connection state from the main process in case the renderer was
  // reloaded (HMR full-page reload in dev, or suspend/resume cycle) while the
  // main-process connections stayed alive.
  await conn.syncFromMain()

  const offProgress = window.api.onJobProgress((e) => jobs.updateProgress(e))
  const offComplete = window.api.onJobComplete((e) => {
    jobs.completeJob(e)
    conn.refreshDbInfo()
  })

  const offUpdateAvailable = window.api.onUpdateAvailable((info) => {
    updateVersion.value = info.version
    updateManual.value = info.manual
    updateState.value = 'available'
  })
  const offUpdateProgress = window.api.onUpdateProgress((percent) => {
    updatePercent.value = percent
  })
  const offUpdateDownloaded = window.api.onUpdateDownloaded(() => {
    updateState.value = 'ready'
  })

  window.addEventListener('beforeunload', () => {
    offProgress()
    offComplete()
    offUpdateAvailable()
    offUpdateProgress()
    offUpdateDownloaded()
  })
})
</script>
