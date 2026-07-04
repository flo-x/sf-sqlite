<template>
  <div class="settings-view">
    <div class="settings-header">
      <h2>Settings</h2>
    </div>

    <div class="settings-body">
      <!-- Encryption warning -->
      <div v-if="!encryptionAvailable" class="alert alert-error" style="margin-bottom:16px">
        OS encryption is not available on this system. API keys will be stored in plain text.
      </div>

      <!-- Top-level settings tabs -->
      <div class="settings-top-tabs">
        <button
          class="settings-top-tab"
          :class="{ active: settingsTab === 'provider' }"
          @click="settingsTab = 'provider'"
        >AI Provider</button>
        <button
          class="settings-top-tab"
          :class="{ active: settingsTab === 'prompt' }"
          @click="settingsTab = 'prompt'"
        >System Prompt</button>
        <button
          class="settings-top-tab"
          :class="{ active: settingsTab === 'network' }"
          @click="settingsTab = 'network'"
        >Network</button>
        <button
          class="settings-top-tab"
          :class="{ active: settingsTab === 'about' }"
          @click="settingsTab = 'about'"
        >About</button>
        <button
          class="settings-top-tab"
          :class="{ active: settingsTab === 'diagnostics' }"
          @click="settingsTab = 'diagnostics'"
        >Diagnostics</button>
      </div>

      <!-- LLM Provider Section -->
      <section v-if="settingsTab === 'provider'" class="settings-section">
        <h3 class="settings-section-title">AI Assistant</h3>

        <!-- Active provider summary -->
        <div class="provider-status">
          <span class="provider-status-label">Active provider:</span>
          <span class="provider-status-name">{{ providerLabel }}</span>
          <span v-if="activeProviderConfigured" class="key-badge key-badge-ok">✓ configured</span>
          <span v-else class="key-badge key-badge-missing">no key</span>
        </div>

        <!-- Provider tabs -->
        <div class="form-group">
          <label>Provider</label>
          <div class="provider-tabs">
            <button
              v-for="p in providers"
              :key="p.id"
              class="provider-tab"
              :class="{ active: settings.provider === p.id }"
              @click="settings.provider = p.id"
            >
              {{ p.label }}
              <span v-if="isProviderConfigured(p.id)" class="tab-dot" title="Key saved" />
            </button>
          </div>
        </div>

        <!-- OpenAI -->
        <template v-if="settings.provider === 'openai'">
          <div class="form-group">
            <label>
              API Key
              <span v-if="openaiKeySet && !settings.openaiKey" class="key-badge key-badge-ok">✓ key saved</span>
            </label>
            <input
              type="password"
              v-model="settings.openaiKey"
              :placeholder="openaiKeySet ? '(re-enter to update)' : 'sk-…'"
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label>Model</label>
            <div class="model-picker">
              <input
                type="text"
                list="openai-models"
                v-model="settings.openaiModel"
                placeholder="e.g. gpt-4o"
                autocomplete="off"
              />
              <datalist id="openai-models">
                <option v-for="m in modelLists['openai']" :key="m" :value="m" />
              </datalist>
              <button
                class="model-load-btn"
                :disabled="loadingModels"
                @click="loadModels"
                title="Load available models"
              >
                <span v-if="loadingModels" class="spinner" style="width:10px;height:10px;border-width:2px" />
                <span v-else>↻</span>
              </button>
            </div>
          </div>
          <div class="form-group">
            <label class="toggle-label">
              <input type="checkbox" v-model="settings.openaiDeepReason" />
              Deep reasoning mode (uses o4-mini — slower, better for complex queries)
            </label>
          </div>
        </template>

        <!-- Anthropic -->
        <template v-if="settings.provider === 'anthropic'">
          <div class="form-group">
            <label>
              API Key
              <span v-if="anthropicKeySet && !settings.anthropicKey" class="key-badge key-badge-ok">✓ key saved</span>
            </label>
            <input
              type="password"
              v-model="settings.anthropicKey"
              :placeholder="anthropicKeySet ? '(re-enter to update)' : 'sk-ant-…'"
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label>Model</label>
            <div class="model-picker">
              <input
                type="text"
                list="anthropic-models"
                v-model="settings.anthropicModel"
                placeholder="e.g. claude-sonnet-4-5"
                autocomplete="off"
              />
              <datalist id="anthropic-models">
                <option v-for="m in modelLists['anthropic']" :key="m" :value="m" />
              </datalist>
              <button
                class="model-load-btn"
                :disabled="loadingModels"
                @click="loadModels"
                title="Load available models"
              >
                <span v-if="loadingModels" class="spinner" style="width:10px;height:10px;border-width:2px" />
                <span v-else>↻</span>
              </button>
            </div>
          </div>
          <div class="form-group">
            <label class="toggle-label">
              <input type="checkbox" v-model="settings.anthropicExtendedThinking" />
              Extended thinking (slower, better for complex queries)
            </label>
          </div>
        </template>

        <!-- Mistral -->
        <template v-if="settings.provider === 'mistral'">
          <div class="form-group">
            <label>
              API Key
              <span v-if="mistralKeySet && !settings.mistralKey" class="key-badge key-badge-ok">✓ key saved</span>
            </label>
            <input
              type="password"
              v-model="settings.mistralKey"
              :placeholder="mistralKeySet ? '(re-enter to update)' : '…'"
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label>Model</label>
            <div class="model-picker">
              <input
                type="text"
                list="mistral-models"
                v-model="settings.mistralModel"
                placeholder="e.g. codestral-latest"
                autocomplete="off"
              />
              <datalist id="mistral-models">
                <option v-for="m in modelLists['mistral']" :key="m" :value="m" />
              </datalist>
              <button
                class="model-load-btn"
                :disabled="loadingModels"
                @click="loadModels"
                title="Load available models"
              >
                <span v-if="loadingModels" class="spinner" style="width:10px;height:10px;border-width:2px" />
                <span v-else>↻</span>
              </button>
            </div>
          </div>
        </template>

        <!-- Ollama -->
        <template v-if="settings.provider === 'ollama'">
          <div class="form-group">
            <label>Base URL</label>
            <input type="url" v-model="settings.ollamaBaseUrl" placeholder="http://localhost:11434" />
          </div>
          <div class="form-group">
            <label>Model</label>
            <div class="model-picker">
              <input
                type="text"
                list="ollama-models"
                v-model="settings.ollamaModel"
                placeholder="e.g. llama3"
                autocomplete="off"
              />
              <datalist id="ollama-models">
                <option v-for="m in modelLists['ollama']" :key="m" :value="m" />
              </datalist>
              <button
                class="model-load-btn"
                :disabled="loadingModels"
                @click="loadModels"
                title="Load available models"
              >
                <span v-if="loadingModels" class="spinner" style="width:10px;height:10px;border-width:2px" />
                <span v-else>↻</span>
              </button>
            </div>
          </div>
          <p class="settings-hint">Tool calling requires a model that supports it (e.g. llama3.1, qwen2.5).</p>
        </template>

        <!-- LiteLLM -->
        <template v-if="settings.provider === 'litellm'">
          <div class="form-group">
            <label>Proxy Base URL</label>
            <input type="url" v-model="settings.litellmBaseUrl" placeholder="http://localhost:4000" />
          </div>
          <div class="form-group">
            <label>
              API Key <span class="settings-hint" style="display:inline;margin:0">(optional)</span>
              <span v-if="litellmKeySet && !settings.litellmApiKey" class="key-badge key-badge-ok">✓ key saved</span>
            </label>
            <input
              type="password"
              v-model="settings.litellmApiKey"
              :placeholder="litellmKeySet ? '(re-enter to update)' : 'leave blank if proxy needs no auth'"
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label>Model</label>
            <div class="model-picker">
              <input
                type="text"
                list="litellm-models"
                v-model="settings.litellmModel"
                placeholder="e.g. gpt-4o"
                autocomplete="off"
              />
              <datalist id="litellm-models">
                <option v-for="m in modelLists['litellm']" :key="m" :value="m" />
              </datalist>
              <button
                class="model-load-btn"
                :disabled="loadingModels"
                @click="loadModels"
                title="Load available models"
              >
                <span v-if="loadingModels" class="spinner" style="width:10px;height:10px;border-width:2px" />
                <span v-else>↻</span>
              </button>
            </div>
          </div>
          <p class="settings-hint">Enter any model name supported by your LiteLLM proxy (e.g. gpt-4o, claude-3-opus, mistral/mistral-large-latest).</p>
        </template>

        <!-- Test connection + Save -->
        <div class="settings-actions">
          <button class="btn btn-secondary" :disabled="testing" @click="testConnection">
            <span v-if="testing" class="spinner" style="width:14px;height:14px;border-width:2px" />
            <span v-else>Test connection</span>
          </button>
          <div v-if="testResult && testResult.ok" class="test-result test-ok">
            {{ testResult.message }}
          </div>
          <button
            v-if="testResult && !testResult.ok"
            class="test-result test-err test-err-btn"
            @click="errorModalOpen = true"
          >
            ✕ Connection failed — click to view
          </button>
          <div style="flex:1" />
          <button class="btn btn-secondary" :disabled="!isDirty || saving" @click="discardChanges">
            Discard
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveSettings">
            <span v-if="saving" class="spinner" style="width:14px;height:14px;border-width:2px" />
            <span v-else>Save</span>
          </button>
          <div v-if="saved" class="test-result test-ok">Saved.</div>
        </div>
      </section>

      <!-- System Prompt Section -->
      <section v-if="settingsTab === 'prompt'" class="settings-section">
        <h3 class="settings-section-title">System Prompt</h3>
        <p class="settings-hint" style="margin-top:0;margin-bottom:14px">
          This prompt is sent to the AI at the start of every conversation.
          Use <code class="prompt-code">{{ schemaPlaceholder }}</code> where you want the live database schema (DDL) to be inserted.
          Leave blank to use the built-in default.
        </p>

        <div class="form-group">
          <label>Template</label>
          <textarea
            class="prompt-textarea"
            v-model="promptText"
            spellcheck="false"
          />
        </div>

        <div class="settings-actions">
          <button
            class="btn btn-secondary"
            :disabled="promptText === defaultPromptTemplate"
            @click="promptText = defaultPromptTemplate"
            title="Discard customisation and restore the built-in prompt"
          >Restore to default</button>
          <div style="flex:1" />
          <button class="btn btn-secondary" :disabled="!isDirty || saving" @click="discardChanges">
            Discard
          </button>
          <button class="btn btn-primary" :disabled="saving" @click="saveSettings">
            <span v-if="saving" class="spinner" style="width:14px;height:14px;border-width:2px" />
            <span v-else>Save</span>
          </button>
          <div v-if="saved" class="test-result test-ok">Saved.</div>
        </div>
      </section>

      <!-- Network Section -->
      <section v-if="settingsTab === 'network'" class="settings-section">
        <h3 class="settings-section-title">Network &amp; Certificates</h3>

        <p class="settings-hint" style="margin-top:0;margin-bottom:14px">
          In corporate environments with a TLS-intercepting proxy, Node.js (used
          for all LLM API calls) needs to trust an extra CA certificate bundle.
          Set <code class="prompt-code">NODE_EXTRA_CA_CERTS</code> in your shell
          profile, or specify the path here explicitly.
        </p>

        <!-- Auto-detected from shell env -->
        <div class="form-group" v-if="networkShellCert">
          <label>Auto-detected from shell</label>
          <div class="network-detected-path">{{ networkShellCert }}</div>
          <div class="settings-hint" style="margin-top:4px">
            This value was read from <code class="prompt-code">NODE_EXTRA_CA_CERTS</code>
            in your login shell and is applied automatically.
          </div>
        </div>

        <!-- Disable toggle -->
        <div class="form-group">
          <label class="network-toggle-row">
            <input type="checkbox" v-model="networkPatchDisabled" />
            <span>Disable CA certificate patch entirely</span>
          </label>
          <div class="settings-hint" style="margin-top:4px">
            When checked, all certificate customisation is bypassed — useful for
            testing whether the cert is the cause of a connection failure.
            Takes effect after Save; requires an app restart to fully apply.
          </div>
        </div>

        <!-- Manual override -->
        <div class="form-group" :class="{ 'network-disabled-section': networkPatchDisabled }">
          <label>CA Certificate file <span style="font-weight:400;color:var(--text-muted)">(override)</span></label>
          <div class="cert-path-row">
            <input
              type="text"
              class="form-input cert-path-input"
              v-model="networkCertPath"
              placeholder="/path/to/ca-bundle.pem"
              spellcheck="false"
            />
            <button class="btn btn-secondary" @click="browseCaCert">Browse…</button>
            <button
              class="btn btn-secondary"
              :disabled="!networkCertPath"
              @click="networkCertPath = ''"
              title="Remove the configured certificate path"
            >Clear</button>
          </div>
          <div class="settings-hint" style="margin-top:4px">
            Overrides the auto-detected path. Leave blank to use the auto-detected
            value (if any).
          </div>
        </div>

        <!-- Active cert indicator -->
        <div v-if="networkActiveCert" class="form-group">
          <label>Currently active</label>
          <div class="network-detected-path network-active-path">{{ networkActiveCert }}</div>
        </div>

        <!-- Shell environment diagnostics -->
        <details class="shell-diag-details">
          <summary class="shell-diag-summary">Shell environment captured at startup</summary>
          <div class="shell-diag-body">
            <div class="shell-diag-row">
              <span class="shell-diag-label">NODE_EXTRA_CA_CERTS</span>
              <span v-if="networkShellCert" class="shell-diag-value">{{ networkShellCert }}</span>
              <span v-else class="shell-diag-value shell-diag-empty">not set</span>
            </div>
            <div class="shell-diag-row">
              <span class="shell-diag-label">PATH</span>
              <span v-if="networkShellPath" class="shell-diag-value shell-diag-path">{{ networkShellPath }}</span>
              <span v-else class="shell-diag-value shell-diag-empty">not captured</span>
            </div>
          </div>
        </details>

        <div class="settings-actions">
          <div style="flex:1" />
          <button
            class="btn btn-secondary"
            :disabled="!isNetworkDirty || networkSaving"
            @click="discardNetworkChanges"
          >
            Discard
          </button>
          <button class="btn btn-primary" :disabled="networkSaving" @click="saveNetworkSettings">
            <span v-if="networkSaving" class="spinner" style="width:14px;height:14px;border-width:2px" />
            <span v-else>Save</span>
          </button>
          <div v-if="networkSaved" class="test-result test-ok">Saved.</div>
        </div>
      </section>

      <!-- ── About ─────────────────────────────────────────────────────────── -->
      <section v-if="settingsTab === 'about'" class="settings-section">
        <h3 class="settings-section-title">About sf-sqlite</h3>

        <div class="about-grid">
          <div class="about-row">
            <span class="about-label">Version</span>
            <code class="about-value">{{ aboutInfo?.appVersion ?? '…' }}</code>
          </div>
          <div class="about-row">
            <span class="about-label">Electron</span>
            <code class="about-value">{{ aboutInfo?.electronVersion ?? '…' }}</code>
          </div>
          <div class="about-row">
            <span class="about-label">Node.js</span>
            <code class="about-value">{{ aboutInfo?.nodeVersion ?? '…' }}</code>
          </div>
          <div class="about-row">
            <span class="about-label">Platform</span>
            <code class="about-value">{{ aboutPlatformLabel }}</code>
          </div>
        </div>

        <div style="margin-top: 20px;">
          <button class="btn btn-secondary" :disabled="aboutChecking" @click="checkForUpdatesManual">
            <span v-if="aboutChecking" class="spinner" style="width:14px;height:14px;border-width:2px" />
            <span v-else>Check for updates</span>
          </button>
        </div>

        <div v-if="aboutUpdateError" class="alert alert-error" style="margin-top: 12px; font-size: 13px;">
          Could not check for updates: {{ aboutUpdateError }}
        </div>

        <div v-if="aboutUpdateResult && !aboutUpdateError" style="margin-top: 12px;">
          <template v-if="aboutUpdateResult.isNewer">
            <div style="font-size: 13px;">
              Version <strong>{{ aboutUpdateResult.latestVersion }}</strong> is available.
            </div>
            <button class="btn btn-primary btn-sm" style="margin-top: 8px;" @click="openReleasesPage">
              Get update from GitHub
            </button>
          </template>
          <div v-else class="test-result test-ok" style="margin-top: 0;">
            You are up to date (latest: {{ aboutUpdateResult.latestVersion }}).
          </div>
        </div>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);">
          <a
            href="#"
            style="font-size: 12px; color: var(--primary); text-decoration: none;"
            @click.prevent="openReleasesPage"
          >View releases on GitHub</a>
        </div>
      </section>

      <!-- ── Diagnostics ───────────────────────────────────────────────────── -->
      <section v-if="settingsTab === 'diagnostics'" class="settings-section">
        <h3 class="settings-section-title">Diagnostics</h3>

        <p class="settings-hint" style="margin-top: 0; margin-bottom: 16px;">
          Enable flags below to capture debug information from the main process.
          Logs appear in real time and can be copied for support.
        </p>

        <div class="diag-flags">
          <label class="diag-flag-row">
            <input type="checkbox" :checked="diagFlags.sfCliExec" @change="toggleFlag('sfCliExec', ($event.target as HTMLInputElement).checked)" />
            <span class="diag-flag-label">SF CLI execution</span>
            <span class="diag-flag-hint">Logs every CLI command: resolved binary, arguments, stdout, stderr, errors.</span>
          </label>
          <label class="diag-flag-row">
            <input type="checkbox" :checked="diagFlags.sfCliAuth" @change="toggleFlag('sfCliAuth', ($event.target as HTMLInputElement).checked)" />
            <span class="diag-flag-label">CLI authentication</span>
            <span class="diag-flag-hint">Logs token extraction in connectCliOrg: source, token length, instanceUrl.</span>
          </label>
        </div>

        <div class="diag-toolbar">
          <span class="diag-log-count">{{ diagLogs.length }} line{{ diagLogs.length === 1 ? '' : 's' }}</span>
          <div style="flex: 1" />
          <button class="btn btn-secondary btn-sm" :disabled="diagLogs.length === 0" @click="copyDiagLogs">
            {{ diagCopied ? '✓ Copied' : 'Copy all' }}
          </button>
          <button class="btn btn-secondary btn-sm" :disabled="diagLogs.length === 0" @click="clearDiag">Clear</button>
        </div>

        <div ref="diagLogEl" class="diag-log-output">
          <span v-if="diagLogs.length === 0" class="diag-log-empty">
            No logs yet. Enable a flag above, then perform the action you want to debug.
          </span>
          <div v-for="(line, i) in diagLogs" :key="i" class="diag-log-line">{{ line }}</div>
        </div>
      </section>
    </div>
  </div>

  <!-- Error detail modal -->
  <teleport to="body">
    <div v-if="errorModalOpen" class="modal-backdrop" @click.self="errorModalOpen = false">
      <div class="modal-box" role="dialog" aria-modal="true" aria-label="Connection error">
        <div class="modal-header">
          <span class="modal-title">Connection error</span>
          <button class="modal-close" @click="errorModalOpen = false" title="Close">✕</button>
        </div>
        <pre class="modal-body">{{ testResult?.message }}</pre>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="copyError">
            {{ copied ? '✓ Copied' : 'Copy to clipboard' }}
          </button>
          <button class="btn btn-primary" @click="errorModalOpen = false">Close</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'

interface LlmSettings {
  provider: 'openai' | 'anthropic' | 'mistral' | 'ollama' | 'litellm'
  openaiKey: string
  openaiModel: string
  openaiDeepReason: boolean
  anthropicKey: string
  anthropicModel: string
  anthropicExtendedThinking: boolean
  mistralKey: string
  mistralModel: string
  ollamaBaseUrl: string
  ollamaModel: string
  litellmBaseUrl: string
  litellmApiKey: string
  litellmModel: string
  systemPromptTemplate: string
}

const providers = [
  { id: 'openai' as const, label: 'OpenAI' },
  { id: 'anthropic' as const, label: 'Anthropic' },
  { id: 'mistral' as const, label: 'Mistral' },
  { id: 'ollama' as const, label: 'Ollama' },
  { id: 'litellm' as const, label: 'LiteLLM' }
]

const settingsTab = ref<'provider' | 'prompt' | 'network' | 'about' | 'diagnostics'>('provider')
const encryptionAvailable = ref(true)
const saving = ref(false)
const saved = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const errorModalOpen = ref(false)
const copied = ref(false)
const loadingModels = ref(false)
const modelLists = ref<Record<string, string[]>>({})
const defaultPromptTemplate = ref('')
const promptText = ref('')
const schemaPlaceholder = '{{schema}}'

// Last-committed (saved or freshly loaded) snapshots — used for dirty-detection and discard.
const committedSettings = ref<LlmSettings | null>(null)
const committedPromptText = ref('')

// ── Network / certificate settings ────────────────────────────────────────────
const networkShellPath = ref<string | null>(null)
const networkShellCert = ref<string | null>(null)
const networkPatchDisabled = ref(false)
const committedNetworkPatchDisabled = ref(false)
const networkCertPath = ref('')
const committedNetworkCertPath = ref('')
const networkActiveCert = ref<string | null>(null)
const networkSaving = ref(false)
const networkSaved = ref(false)

const isNetworkDirty = computed(() =>
  networkCertPath.value !== committedNetworkCertPath.value ||
  networkPatchDisabled.value !== committedNetworkPatchDisabled.value
)

const isDirty = computed(() => {
  if (!committedSettings.value) return false
  return (
    JSON.stringify(settings.value) !== JSON.stringify(committedSettings.value) ||
    promptText.value !== committedPromptText.value
  )
})

// Whether an encrypted key blob exists in the settings file for each provider.
// True even when decryption fails (e.g. macOS keychain permission denied).
const openaiKeySet = ref(false)
const anthropicKeySet = ref(false)
const mistralKeySet = ref(false)
const litellmKeySet = ref(false)

const settings = ref<LlmSettings>({
  provider: 'openai',
  openaiKey: '',
  openaiModel: 'gpt-4o',
  openaiDeepReason: false,
  anthropicKey: '',
  anthropicModel: 'claude-sonnet-4-5',
  anthropicExtendedThinking: false,
  mistralKey: '',
  mistralModel: 'codestral-latest',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3',
  litellmBaseUrl: 'http://localhost:4000',
  litellmApiKey: '',
  litellmModel: 'gpt-4o',
  systemPromptTemplate: ''
})

const providerLabel = computed(() => {
  return providers.find(p => p.id === settings.value.provider)?.label ?? settings.value.provider
})


const activeProviderConfigured = computed(() => {
  return isProviderConfigured(settings.value.provider)
})

function isProviderConfigured(id: string): boolean {
  if (id === 'openai') {
    return openaiKeySet.value || settings.value.openaiKey !== ''
  }
  if (id === 'anthropic') {
    return anthropicKeySet.value || settings.value.anthropicKey !== ''
  }
  if (id === 'mistral') {
    return mistralKeySet.value || settings.value.mistralKey !== ''
  }
  if (id === 'ollama') {
    return settings.value.ollamaBaseUrl !== ''
  }
  if (id === 'litellm') {
    return settings.value.litellmBaseUrl !== ''
  }
  return false
}

// ── About tab ──────────────────────────────────────────────────────────────
const aboutInfo = ref<{ appVersion: string; electronVersion: string; nodeVersion: string; platform: string } | null>(null)
const aboutChecking = ref(false)
const aboutUpdateResult = ref<{ latestVersion: string; isNewer: boolean } | null>(null)
const aboutUpdateError = ref<string | null>(null)

const aboutPlatformLabel = computed(() => {
  const p = aboutInfo.value?.platform
  if (p === 'darwin') {
    return 'macOS'
  }
  if (p === 'win32') {
    return 'Windows'
  }
  if (p === 'linux') {
    return 'Linux'
  }
  return p ?? '…'
})

function openReleasesPage(): void {
  window.api.openReleasesPage()
}

async function checkForUpdatesManual(): Promise<void> {
  aboutChecking.value = true
  aboutUpdateResult.value = null
  aboutUpdateError.value = null
  try {
    aboutUpdateResult.value = await window.api.checkForUpdates()
  } catch (e) {
    // Electron IPC can serialize errors with undefined message; fall back to String(e).
    const raw = (e instanceof Error ? e.message : null) ?? String(e)
    // Strip the Electron "Error invoking remote method '...':" prefix.
    aboutUpdateError.value = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  } finally {
    aboutChecking.value = false
  }
}

// ── Diagnostics tab ────────────────────────────────────────────────────────
const diagFlags = ref({ sfCliExec: false, sfCliAuth: false })
const diagLogs = ref<string[]>([])
const diagCopied = ref(false)
const diagLogEl = ref<HTMLElement | null>(null)

async function toggleFlag(flag: 'sfCliExec' | 'sfCliAuth', value: boolean): Promise<void> {
  diagFlags.value[flag] = value
  await window.api.setDebugFlags({ [flag]: value })
}

async function clearDiag(): Promise<void> {
  await window.api.clearDebugLogs()
  diagLogs.value = []
}

async function copyDiagLogs(): Promise<void> {
  await navigator.clipboard.writeText(diagLogs.value.join('\n'))
  diagCopied.value = true
  setTimeout(() => { diagCopied.value = false }, 2000)
}

let removeDebugLogListener: (() => void) | null = null

onUnmounted(() => {
  removeDebugLogListener?.()
})

onMounted(async () => {
  // Load basic version info immediately (no network call)
  try {
    aboutInfo.value = await window.api.getVersionInfo()
  } catch {
    // Non-critical; the About tab will just show '…' placeholders.
  }

  // Load current debug flags and existing log buffer from main process.
  try {
    diagFlags.value = await window.api.getDebugFlags()
    diagLogs.value = await window.api.getDebugLogs()
  } catch {
    // non-critical
  }

  // Stream new log lines from main process in real time.
  removeDebugLogListener = window.api.onDebugLog((line) => {
    diagLogs.value.push(line)
    nextTick(() => {
      if (diagLogEl.value) {
        diagLogEl.value.scrollTop = diagLogEl.value.scrollHeight
      }
    })
  })

  try {
    const raw = await window.api.getLlmSettings() as LlmSettings & {
      encryptionAvailable?: boolean
      openaiKeySet?: boolean
      anthropicKeySet?: boolean
      mistralKeySet?: boolean
      litellmKeySet?: boolean
      defaultSystemPromptTemplate?: string
    }
    encryptionAvailable.value = raw.encryptionAvailable !== false
    openaiKeySet.value = raw.openaiKeySet ?? false
    anthropicKeySet.value = raw.anthropicKeySet ?? false
    mistralKeySet.value = raw.mistralKeySet ?? false
    litellmKeySet.value = raw.litellmKeySet ?? false
    settings.value = {
      provider: raw.provider ?? 'openai',
      openaiKey: raw.openaiKey ?? '',
      openaiModel: raw.openaiModel ?? 'gpt-4o',
      openaiDeepReason: Boolean(raw.openaiDeepReason),
      anthropicKey: raw.anthropicKey ?? '',
      anthropicModel: raw.anthropicModel ?? 'claude-sonnet-4-5',
      anthropicExtendedThinking: Boolean(raw.anthropicExtendedThinking),
      mistralKey: raw.mistralKey ?? '',
      mistralModel: raw.mistralModel ?? 'codestral-latest',
      ollamaBaseUrl: raw.ollamaBaseUrl ?? 'http://localhost:11434',
      ollamaModel: raw.ollamaModel ?? 'llama3',
      litellmBaseUrl: raw.litellmBaseUrl ?? 'http://localhost:4000',
      litellmApiKey: raw.litellmApiKey ?? '',
      litellmModel: raw.litellmModel ?? 'gpt-4o',
      systemPromptTemplate: raw.systemPromptTemplate ?? ''
    }
    defaultPromptTemplate.value = raw.defaultSystemPromptTemplate ?? ''
    promptText.value = settings.value.systemPromptTemplate || defaultPromptTemplate.value
    // Capture committed state so discard can restore it
    committedSettings.value = { ...settings.value }
    committedPromptText.value = promptText.value
  } catch {
    // Fresh install — use defaults
  }

  try {
    const netSettings = await window.api.getNetworkSettings()
    networkShellPath.value = netSettings.shellPath
    networkShellCert.value = netSettings.shellCaCertPath
    networkCertPath.value = netSettings.savedCaCertPath ?? ''
    committedNetworkCertPath.value = networkCertPath.value
    networkPatchDisabled.value = netSettings.patchDisabled
    committedNetworkPatchDisabled.value = netSettings.patchDisabled
    networkActiveCert.value = await window.api.getActiveCaCertPath()
  } catch {
    // non-fatal
  }
})

async function saveSettings(): Promise<void> {
  saving.value = true
  saved.value = false
  // Store empty string when the user hasn't deviated from the default, so the
  // backend falls back to the built-in prompt automatically.
  settings.value.systemPromptTemplate =
    promptText.value === defaultPromptTemplate.value ? '' : promptText.value
  try {
    await window.api.saveLlmSettings({ ...settings.value } as Record<string, unknown>)
    // Refresh keySet flags so the "✓ key saved" badge reflects the new state.
    if (settings.value.openaiKey !== '') {
      openaiKeySet.value = true
    }
    if (settings.value.anthropicKey !== '') {
      anthropicKeySet.value = true
    }
    if (settings.value.mistralKey !== '') {
      mistralKeySet.value = true
    }
    if (settings.value.litellmApiKey !== '') {
      litellmKeySet.value = true
    }
    // Advance the committed snapshot so discard knows the new baseline.
    committedSettings.value = { ...settings.value }
    committedPromptText.value = promptText.value
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
  } finally {
    saving.value = false
  }
}

function discardChanges(): void {
  if (!committedSettings.value) return
  settings.value = { ...committedSettings.value }
  promptText.value = committedPromptText.value
  testResult.value = null
}

async function browseCaCert(): Promise<void> {
  const picked = await window.api.browseCaCert()
  if (picked) {
    networkCertPath.value = picked
  }
}

async function saveNetworkSettings(): Promise<void> {
  networkSaving.value = true
  networkSaved.value = false
  try {
    const pathToSave = networkCertPath.value.trim() || null
    await window.api.setCaCertPath(pathToSave, networkPatchDisabled.value)
    committedNetworkCertPath.value = networkCertPath.value
    committedNetworkPatchDisabled.value = networkPatchDisabled.value
    networkActiveCert.value = await window.api.getActiveCaCertPath()
    networkSaved.value = true
    setTimeout(() => { networkSaved.value = false }, 2000)
  } finally {
    networkSaving.value = false
  }
}

function discardNetworkChanges(): void {
  networkCertPath.value = committedNetworkCertPath.value
  networkPatchDisabled.value = committedNetworkPatchDisabled.value
}

async function copyError(): Promise<void> {
  await navigator.clipboard.writeText(testResult.value?.message ?? '')
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  errorModalOpen.value = false
  copied.value = false

  try {
    // Pass the current in-memory settings (with plaintext keys as typed) directly
    // to main — no file write/read roundtrip, so the test always uses exactly
    // what the user has on screen regardless of save state.
    await window.api.testLlmConnection({ ...settings.value } as Record<string, unknown>)
    testResult.value = { ok: true, message: '✓ Connection successful' }
  } catch (err) {
    testResult.value = {
      ok: false,
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    testing.value = false
  }
}

async function loadModels(): Promise<void> {
  loadingModels.value = true
  try {
    const models = await window.api.listLlmModels({ ...settings.value } as Record<string, unknown>)
    modelLists.value = { ...modelLists.value, [settings.value.provider]: models }
  } catch (err) {
    testResult.value = {
      ok: false,
      message: `Failed to load models: ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    loadingModels.value = false
  }
}
</script>

<style scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}

.settings-header {
  padding: 16px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.settings-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  max-width: 560px;
}

.settings-section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

/* Active provider status banner */
.provider-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  margin-bottom: 16px;
}

.provider-status-label {
  color: var(--text-muted);
}

.provider-status-name {
  font-weight: 600;
  color: var(--text);
}

/* Key status badges (inline next to label or tab dot) */
.key-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 10px;
  line-height: 1.6;
}

.key-badge-ok {
  background: #dcfce7;
  color: #166534;
}

.key-badge-missing {
  background: #fef9c3;
  color: #854d0e;
}

/* Small dot on provider tab when key is stored */
.tab-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  margin-left: 4px;
  vertical-align: middle;
  flex-shrink: 0;
}

/* Provider tabs */
.provider-tabs {
  display: flex;
  gap: 4px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 3px;
}

.provider-tab {
  flex: 1;
  padding: 5px 8px;
  border: none;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  background: transparent;
  color: var(--text-muted);
  transition: background 0.15s, color 0.15s;
}

.provider-tab.active {
  background: var(--surface);
  color: var(--primary);
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
}

.provider-tab:hover:not(.active) {
  background: rgba(0,0,0,0.04);
  color: var(--text);
}

/* Toggle */
.toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 400;
  color: var(--text);
  font-size: 13px;
}

.toggle-label input[type="checkbox"] {
  width: auto;
  margin: 0;
}

.settings-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: -8px;
  margin-bottom: 12px;
}

/* Actions */
.settings-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.test-result {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}

.test-ok {
  background: #dcfce7;
  color: #166534;
}

.test-err {
  background: #fee2e2;
  color: #991b1b;
}

.test-err-btn {
  cursor: pointer;
  border: none;
  font-family: inherit;
  white-space: nowrap;
}

.test-err-btn:hover {
  background: #fecaca;
}

/* ── Error modal ──────────────────────────────────────────────────────────── */

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(600px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: #991b1b;
}

.modal-close {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--surface2);
  color: var(--text);
}

.modal-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  margin: 0;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--surface2);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

/* Model picker — text input + load button */
.model-picker {
  display: flex;
  align-items: center;
  gap: 6px;
}

.model-picker input {
  flex: 1;
  min-width: 0;
}

.model-load-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  font-size: 14px;
  color: var(--text-muted);
  transition: background 0.15s, color 0.15s;
}

.model-load-btn:hover:not(:disabled) {
  background: var(--surface2, var(--surface));
  color: var(--text);
  border-color: var(--accent, #3b82f6);
}

.model-load-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Top-level settings tab bar */
.settings-top-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0;
}

.settings-top-tab {
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--text-muted);
  margin-bottom: -1px;
  border-radius: 0;
  transition: color 0.15s, border-color 0.15s;
}

.settings-top-tab:hover {
  color: var(--text);
}

.settings-top-tab.active {
  color: var(--text);
  border-bottom-color: var(--accent, #3b82f6);
}

/* System prompt textarea */
.prompt-textarea {
  width: 100%;
  min-height: 380px;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  color: var(--text);
  resize: vertical;
  box-sizing: border-box;
}

.prompt-textarea:focus {
  outline: none;
  border-color: var(--accent, #3b82f6);
}

.prompt-code {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
  background: var(--surface2, var(--surface));
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
  color: var(--accent, #3b82f6);
}

/* Network / certificate settings */
.cert-path-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cert-path-input {
  flex: 1;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
}

.network-detected-path {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  padding: 6px 10px;
  background: var(--surface2, var(--surface));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  color: var(--text-muted);
  word-break: break-all;
}

.network-active-path {
  color: var(--success, #22c55e);
  border-color: var(--success, #22c55e);
}

/* Network disable toggle */
.network-toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 500;
}

.network-disabled-section {
  opacity: 0.4;
  pointer-events: none;
}

/* Shell environment diagnostics */
.shell-diag-details {
  margin: 20px 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 4px);
  background: var(--surface2, var(--surface));
}

.shell-diag-summary {
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--text-muted);
  list-style: none;
}

.shell-diag-summary::before {
  content: '▶ ';
  font-size: 10px;
}

details[open] > .shell-diag-summary::before {
  content: '▼ ';
}

.shell-diag-body {
  padding: 8px 12px 12px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.shell-diag-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.shell-diag-label {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.shell-diag-value {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
  color: var(--text);
  word-break: break-all;
  white-space: pre-wrap;
}

.shell-diag-path {
  /* PATH entries are colon-separated — break at each colon so they read like a list */
  word-break: break-all;
}

.shell-diag-empty {
  color: var(--text-muted);
  font-style: italic;
}

/* ── About tab ────────────────────────────────────────────────────────────── */
.about-grid {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13px;
  max-width: 480px;
}

.about-row {
  display: contents;
}

.about-label {
  padding: 9px 14px;
  background: var(--surface2, var(--surface));
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.about-value {
  padding: 9px 14px;
  background: transparent;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
}

.about-row:last-child .about-label,
.about-row:last-child .about-value {
  border-bottom: none;
}

/* ── Diagnostics tab ──────────────────────────────────────────────────────── */
.diag-flags {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 18px;
}

.diag-flag-row {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  column-gap: 10px;
  row-gap: 2px;
  align-items: start;
  cursor: pointer;
}

.diag-flag-row input[type="checkbox"] {
  grid-row: 1;
  margin-top: 2px;
}

.diag-flag-label {
  grid-row: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.diag-flag-hint {
  grid-column: 2;
  grid-row: 2;
  font-size: 11px;
  color: var(--text-muted);
}

.diag-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.diag-log-count {
  font-size: 11px;
  color: var(--text-muted);
}

.diag-log-output {
  background: var(--surface2, #1e1e1e);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  height: 320px;
  overflow-y: auto;
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text);
}

.diag-log-empty {
  color: var(--text-muted);
  font-style: italic;
  font-family: inherit;
  font-size: 11px;
}

.diag-log-line {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
