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

    <div class="app-body">
    <!-- Sidebar -->
    <nav class="sidebar">
      <div class="sidebar-logo">SF</div>
      <NavButton to="/query" tooltip="Query Editor" :disabled="!conn.dbConnected">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
      </NavButton>
      <NavButton to="/scripts" tooltip="JS Scripts" :disabled="!conn.dbConnected">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M9 9l-3 3 3 3"/><path d="M15 9l3 3-3 3"/>
          <line x1="12" y1="7" x2="12" y2="17" stroke-dasharray="2 2"/>
        </svg>
      </NavButton>
      <NavButton to="/extract" tooltip="SF → SQLite" :disabled="!conn.bothConnected">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
          <rect x="3" y="2" width="18" height="4" rx="1" fill="currentColor" opacity="0.3"/>
          <rect x="3" y="18" width="18" height="4" rx="1" fill="currentColor" opacity="0.3"/>
        </svg>
      </NavButton>
      <NavButton to="/writeback" tooltip="SQLite → SF" :disabled="!conn.bothConnected">
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
import { onMounted } from 'vue'
import { useConnectionStore } from './stores/connection'
import { useJobStore } from './stores/job'
import NavButton from './components/NavButton.vue'

const conn = useConnectionStore()
const jobs = useJobStore()

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
  window.addEventListener('beforeunload', () => { offProgress(); offComplete() })
})
</script>
