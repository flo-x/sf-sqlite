<template>
  <div class="conn-view">
    <div class="conn-columns">
      <!-- SQLite card -->
      <div class="card conn-card">
        <div class="conn-card-header">
          <div class="conn-card-logo db-logo">🗄</div>
          <h3>SQLite Database</h3>
          <span v-if="conn.dbConnected" class="badge badge-green" style="margin-left: auto;">Open</span>
          <span v-else class="badge badge-gray" style="margin-left: auto;">Not open</span>
        </div>

        <template v-if="conn.dbConnected">
          <div class="conn-info">
            <div style="font-family: monospace; font-size: 12px; word-break: break-all;">{{ conn.dbPath }}</div>
            <div class="text-muted" style="font-size:12px; margin-top: 4px;">{{ conn.dbTables.length }} tables/views</div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary btn-sm" @click="conn.openDatabase()">Open Different</button>
            <button class="btn btn-secondary btn-sm" @click="conn.createDatabase()">Create New</button>
          </div>
        </template>

        <template v-else>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">Open an existing SQLite database or create a new one.</p>

          <!-- Recent databases -->
          <div v-if="recentDbs.length" class="recent-dbs">
            <div class="recent-dbs-title">Recent</div>
            <div
              v-for="r in recentDbs"
              :key="r.path"
              class="recent-db-item"
              :title="r.path"
              @click="openRecent(r.path)"
            >
              <span class="recent-db-icon">🗄</span>
              <div class="recent-db-info">
                <span class="recent-db-name">{{ r.name }}</span>
                <span class="recent-db-path">{{ r.path }}</span>
              </div>
              <button class="recent-db-remove" title="Remove from list" @click.stop="removeRecent(r.path)">✕</button>
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
            <button class="btn btn-primary" :disabled="conn.dbConnecting" @click="conn.openDatabase()">
              <span v-if="conn.dbConnecting" class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
              Open Other Database…
            </button>
            <button class="btn btn-secondary" :disabled="conn.dbConnecting" @click="conn.createDatabase()">
              Create New Database…
            </button>
          </div>
        </template>
      </div>

      <!-- Salesforce card -->
      <div class="card conn-card">
        <div class="conn-card-header">
          <div class="conn-card-logo sf-logo">⚡</div>
          <h3>Salesforce</h3>
          <span v-if="conn.sfConnected" class="badge badge-green" style="margin-left: auto;">Connected</span>
          <span v-else-if="conn.sfAutoConnecting" class="badge badge-gray" style="margin-left: auto; display:flex; align-items:center; gap:5px;">
            <span class="spinner" style="width:10px;height:10px;border-width:2px;"></span>Connecting…
          </span>
          <span v-else class="badge badge-gray" style="margin-left: auto;">Disconnected</span>
        </div>

        <template v-if="conn.sfConnected">
          <div class="conn-info">
            <div><strong>{{ conn.sfOrg?.username }}</strong></div>
            <div class="text-muted" style="font-size:12px;">{{ conn.sfOrg?.instanceUrl }}</div>
            <div class="text-muted" style="font-size:12px;">Org ID: {{ conn.sfOrg?.orgId }}</div>
          </div>
          <button class="btn btn-danger btn-sm" @click="conn.disconnectSF()">Disconnect</button>
        </template>

        <template v-else-if="conn.sfAutoConnecting">
          <div style="display:flex; align-items:center; gap:8px; padding: 16px 0; color: var(--text-muted); font-size:13px;">
            <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
            Connecting to <strong style="margin-left:2px;">{{ conn.sfAutoConnectError?.username ?? 'saved org' }}</strong>…
          </div>
        </template>

        <template v-else-if="conn.sfAutoConnectError">
          <div class="alert alert-error" style="margin-top: 12px; font-size: 13px;">
            <div style="font-weight:600; margin-bottom:4px;">Auto-connect failed for <code>{{ conn.sfAutoConnectError.username }}</code></div>
            <div style="white-space: pre-wrap; word-break: break-word;">{{ conn.sfAutoConnectError.message }}</div>
          </div>
          <div style="margin-top: 10px; display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" @click="switchToCliTab">Connect manually</button>
          </div>
        </template>

        <template v-else>
          <div class="tab-bar" style="border-bottom: 1px solid var(--border); margin: -1px -1px 0;">
            <div class="tab-item" :class="{ active: sfTab === 'cli' }" @click="switchToCliTab">SF CLI</div>
            <div class="tab-item" :class="{ active: sfTab === 'oauth' }" @click="sfTab = 'oauth'">OAuth 2.0</div>
          </div>

          <!-- ── SF CLI tab ── -->
          <div v-if="sfTab === 'cli'" class="conn-form" style="gap: 0;">
            <div v-if="cliLoading" style="display:flex; align-items:center; gap:8px; padding: 12px 0; color: var(--text-muted); font-size:13px;">
              <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
              Detecting authenticated orgs…
            </div>
            <div v-else-if="cliOrgs.length === 0" style="padding: 12px 0;">
              <p style="font-size:13px; color: var(--text-muted); margin-bottom: 10px;">
                No orgs found. Authenticate one with:
              </p>
              <code style="font-size:12px; background: var(--surface2); padding: 6px 10px; border-radius: 4px; display:block;">sf org login web</code>
              <button class="btn btn-secondary btn-sm" style="margin-top: 10px;" @click="loadCliOrgs">Refresh</button>
            </div>
            <template v-else>
              <div class="cli-org-list">
                <div
                  v-for="org in cliOrgs"
                  :key="org.username"
                  class="cli-org-item"
                  :class="{ selected: selectedCliOrg === org.username }"
                  @click="selectedCliOrg = org.username"
                >
                  <div class="cli-org-main">
                    <span class="cli-org-username">{{ org.alias ? `${org.alias}  (${org.username})` : org.username }}</span>
                    <span v-if="org.isScratch" class="badge badge-gray" style="font-size:10px; padding: 1px 5px;">scratch</span>
                    <span v-if="org.isDefaultOrg" class="badge badge-green" style="font-size:10px; padding: 1px 5px;">default</span>
                  </div>
                  <div v-if="org.instanceUrl" class="cli-org-url">{{ org.instanceUrl }}</div>
                </div>
              </div>
              <div v-if="sfError" class="alert alert-error" style="margin-top: 8px;">{{ sfError }}</div>
              <div style="display:flex; gap:8px; margin-top: 10px;">
                <button class="btn btn-primary" :disabled="!selectedCliOrg || conn.sfConnecting" @click="loginCli">
                  <span v-if="conn.sfConnecting" class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
                  Connect
                </button>
                <button class="btn btn-secondary btn-sm" @click="loadCliOrgs">Refresh</button>
              </div>
            </template>
          </div>

          <div v-if="sfTab === 'oauth'" class="conn-form">
            <div class="oauth-requirements">
              <div class="oauth-req-title">Requirements</div>
              <div class="oauth-req-item">
                <span class="oauth-req-num">1</span>
                <span>Create a <strong>Connected App</strong> in Salesforce (Setup → App Manager → New Connected App).</span>
              </div>
              <div class="oauth-req-item">
                <span class="oauth-req-num">2</span>
                <span>Enable <strong>OAuth Settings</strong>, tick <em>Enable for Device Flow</em>, and add the following as an allowed callback URL:</span>
              </div>
              <code class="oauth-callback-hint">http://localhost:[8788–8987]/callback</code>
              <div class="oauth-req-item" style="margin-top: 6px;">
                <span class="oauth-req-num">3</span>
                <span>Add the <strong>Access and manage your data (api)</strong> and <strong>Perform requests on your behalf at any time (refresh_token)</strong> OAuth scopes.</span>
              </div>
              <div class="oauth-req-item">
                <span class="oauth-req-num">4</span>
                <span>Copy the <strong>Consumer Key</strong> (Client ID) from the Connected App and paste it below.</span>
              </div>
            </div>
            <div class="form-group">
              <label>Consumer Key (Client ID)</label>
              <input v-model="oauthClientId" type="text" placeholder="3MVG9…" />
            </div>
            <p style="font-size:12px; color: var(--text-muted); margin-bottom: 12px;">
              A browser window will open for Salesforce login. After authentication, you'll be redirected back automatically.
            </p>
            <div v-if="sfError" class="alert alert-error">{{ sfError }}</div>
            <button class="btn btn-primary" :disabled="conn.sfConnecting || !oauthClientId" @click="loginOAuth">
              <span v-if="conn.sfConnecting" class="spinner" style="width:14px;height:14px;border-width:2px;"></span>
              <span>Login with Browser</span>
            </button>
          </div>
        </template>

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useConnectionStore } from '../stores/connection'
import type { CliOrg, RecentDatabase } from '../../../shared/types'

const conn = useConnectionStore()
const sfTab = ref<'cli' | 'oauth'>('cli')
const sfError = ref('')
const oauthClientId = ref('')

// ── SF CLI ───────────────────────────────────────────────────────────────────
const cliOrgs = ref<CliOrg[]>([])
const cliLoading = ref(false)
const selectedCliOrg = ref<string>('')

async function loadCliOrgs(): Promise<void> {
  cliLoading.value = true
  cliOrgs.value = []
  selectedCliOrg.value = ''
  try {
    cliOrgs.value = await window.api.listCliOrgs()
    if (cliOrgs.value.length > 0) {
      const def = cliOrgs.value.find((o) => o.isDefaultOrg)
      selectedCliOrg.value = def?.username ?? cliOrgs.value[0].username
    }
  } finally {
    cliLoading.value = false
  }
}

function switchToCliTab(): void {
  sfTab.value = 'cli'
  if (cliOrgs.value.length === 0 && !cliLoading.value) loadCliOrgs()
}

async function loginCli(): Promise<void> {
  if (!selectedCliOrg.value) return
  sfError.value = ''
  try {
    await conn.connectSFCli(selectedCliOrg.value)
  } catch (e) {
    sfError.value = e instanceof Error ? e.message : String(e)
  }
}

// ── Recent databases ─────────────────────────────────────────────────────────
const recentDbs = ref<RecentDatabase[]>([])

async function loadRecentDbs(): Promise<void> {
  recentDbs.value = await window.api.listRecentDatabases()
}

async function openRecent(filePath: string): Promise<void> {
  await conn.openDatabase(filePath)
  await loadRecentDbs()
}

async function removeRecent(filePath: string): Promise<void> {
  await window.api.removeRecentDatabase(filePath)
  await loadRecentDbs()
}

onMounted(() => {
  loadCliOrgs()
  loadRecentDbs()
})

async function loginOAuth(): Promise<void> {
  sfError.value = ''
  try {
    await conn.connectOAuth(oauthClientId.value)
  } catch (e) {
    sfError.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<style scoped>
.conn-view { padding: 24px; overflow-y: auto; height: 100%; }
.conn-columns { display: flex; gap: 24px; max-width: 900px; margin: 0 auto; }
.conn-card { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.conn-card-header { display: flex; align-items: center; gap: 10px; }
.conn-card-logo { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
.sf-logo { background: #e8f0fe; }
.db-logo { background: #f0fdf4; }
.conn-info { background: var(--surface2); padding: 10px 12px; border-radius: var(--radius-sm); }
.conn-form { display: flex; flex-direction: column; gap: 0; }
.conn-form .form-group { margin-bottom: 10px; }
.text-muted { color: var(--text-muted); }
.oauth-requirements { background: var(--surface2); border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 8px; }
.oauth-req-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 2px; }
.oauth-req-item { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.5; }
.oauth-req-num { flex-shrink: 0; width: 18px; height: 18px; border-radius: 50%; background: var(--primary); color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-top: 1px; }
.oauth-callback-hint { font-size: 11px; background: var(--surface); padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); display: block; margin-left: 26px; user-select: all; }
.cli-org-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
.cli-org-item { padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; border: 1px solid transparent; }
.cli-org-item:hover { background: var(--surface2); }
.cli-org-item.selected { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
.cli-org-main { display: flex; align-items: center; gap: 6px; }
.cli-org-username { font-size: 13px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cli-org-url { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

/* Recent databases */
.recent-dbs { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.recent-dbs-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); padding: 2px 0 4px; }
.recent-db-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-sm); cursor: pointer; border: 1px solid transparent; }
.recent-db-item:hover { background: var(--surface2); border-color: var(--border); }
.recent-db-icon { font-size: 14px; flex-shrink: 0; }
.recent-db-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.recent-db-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent-db-path { font-size: 10px; color: var(--text-muted); font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent-db-remove { flex-shrink: 0; background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 11px; padding: 2px 5px; border-radius: 3px; opacity: 0; transition: opacity 0.1s; }
.recent-db-item:hover .recent-db-remove { opacity: 1; }
.recent-db-remove:hover { background: var(--danger); color: #fff; }
</style>
