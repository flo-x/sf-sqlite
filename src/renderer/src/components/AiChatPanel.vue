<template>
  <div class="ai-chat-panel">
    <!-- Header -->
    <div class="ai-chat-header">
      <div class="ai-chat-title-group">
        <span v-if="activeProvider" class="ai-provider-badge">{{ activeProvider }}</span>
        <span v-if="activeProvider && !activeKeySet" class="ai-provider-badge ai-provider-badge-warn">no key</span>
      </div>
      <div class="ai-chat-header-actions">
        <button class="btn btn-ghost btn-sm" @click="startNewConversation" title="New conversation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          New
        </button>
        <router-link to="/settings" class="btn btn-ghost btn-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
          </svg>
          Settings
        </router-link>
      </div>
    </div>

    <!-- Disclaimer banner -->
    <div class="ai-disclaimer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="ai-disclaimer-icon" style="flex-shrink:0;margin-top:1px">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <ul class="ai-disclaimer-list">
        <li>Uses tokens from your provider — may incur costs.</li>
        <li>Receives your database schema and may query data.</li>
        <li>Can run DDL/DML and JavaScript with your confirmation.</li>
        <li>If asked, can generate SQL and Javascript programs.</li>
      </ul>
    </div>

    <!-- Message list -->
    <div class="ai-messages" ref="messagesEl">
      <div v-if="messages.length === 0" class="ai-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" style="opacity:0.3">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <p>Ask a question to get started.</p>
        <p class="ai-empty-hint">e.g. "Show me the 10 most recent orders" or "How many rows are in each table?"</p>
      </div>

      <template v-for="(msg, idx) in messages" :key="idx">
        <div v-if="msg.role === 'user'" class="ai-msg ai-msg-user">
          <div class="ai-bubble ai-bubble-user">{{ msg.content }}</div>
        </div>

        <div v-if="msg.role === 'tool_call'" class="ai-tool-step">
          <div class="ai-tool-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="flex-shrink:0">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            <span>Ran <code>{{ msg.toolName }}</code></span>
          </div>
          <div class="ai-tool-rows">
            <div class="ai-tool-row">
              <span class="ai-tool-row-label">Input</span>
              <button class="ai-tool-snippet" @click="openToolModal('Input — ' + msg.toolName, formatToolInput(msg.content))">
                <code>{{ truncate(formatToolInput(msg.content), 120) }}</code>
              </button>
            </div>
            <div v-if="msg.result !== undefined" class="ai-tool-row" :class="{ 'ai-tool-row-error': parseToolResult(msg.result ?? '').type === 'error' }">
              <span class="ai-tool-row-label">Result</span>
              <button class="ai-tool-snippet" @click="openToolResultModal(msg.toolName ?? '', msg.result ?? '')">
                <code>{{ truncate(toolResultSummary(msg.result ?? ''), 120) }}</code>
              </button>
            </div>
          </div>
        </div>

        <div v-if="msg.role === 'tool_confirm'" class="ai-tool-confirm">
          <div class="ai-tool-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="flex-shrink:0">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>{{ msg.confirmType === 'javascript' ? 'Script execution requested' : 'Database change requested' }}</span>
          </div>
          <p class="confirm-reason">{{ msg.confirmReason }}</p>
          <pre class="confirm-sql">{{ msg.content }}</pre>
          <div v-if="msg.confirmPending" class="confirm-actions">
            <p class="confirm-warning">{{ msg.confirmType === 'javascript' ? 'This will run JavaScript code that can read and modify the database.' : 'This will permanently modify the database.' }}</p>
            <div class="confirm-btns">
              <button class="btn btn-secondary btn-sm" @click="rejectConfirm(idx)">Cancel</button>
              <button class="btn btn-danger btn-sm" @click="approveConfirm(idx)">Execute</button>
            </div>
          </div>
          <div v-else-if="msg.result === 'executing'" class="confirm-outcome confirm-executing">
            <span class="spinner" style="width:10px;height:10px;border-width:2px;"></span> Executing…
            <button
              v-if="msg.confirmType === 'javascript'"
              class="btn btn-secondary btn-sm"
              style="margin-left:10px"
              @click="cancelTool(idx)"
            >Cancel</button>
          </div>
          <div v-else-if="msg.result === 'error'" class="confirm-outcome confirm-error">
            <span>✗ Failed: {{ msg.confirmError }}</span>
          </div>
          <div v-else class="confirm-outcome" :class="msg.result === 'executed' ? 'confirm-ok' : 'confirm-cancelled'">
            {{ msg.result === 'executed' ? '✓ Executed' : '✗ Cancelled' }}
          </div>
        </div>

        <div v-if="msg.role === 'assistant'" class="ai-msg ai-msg-assistant">
          <div class="ai-bubble ai-bubble-assistant">
            <!-- Streaming: show raw text -->
            <template v-if="msg.streaming">
              <pre class="ai-streaming-text">{{ msg.content }}</pre>
              <span class="ai-cursor">▋</span>
            </template>
            <!-- Parsed structured response (only when at least one field is present) -->
            <template v-else-if="msg.parsed && (msg.parsed.sql || msg.parsed.javascript || msg.parsed.explanation || (msg.parsed.warnings && msg.parsed.warnings.length > 0))">
              <div v-if="msg.parsed.sql" class="ai-sql-block">
                <div class="ai-sql-header">
                  <span class="ai-sql-label">SQL</span>
                  <div class="ai-sql-actions">
                    <button
                      class="btn btn-secondary btn-sm"
                      :disabled="runningSqlIdx.has(idx)"
                      @click="runSql(idx, msg.parsed.sql!)"
                    >{{ runningSqlIdx.has(idx) ? 'Running…' : 'Run' }}</button>
                    <button class="btn btn-primary btn-sm" @click="$emit('insert-sql', msg.parsed.sql)">Insert</button>
                  </div>
                </div>
                <pre class="ai-sql-code">{{ msg.parsed.sql }}</pre>
              </div>
              <div v-if="msg.parsed.javascript" class="ai-js-block">
                <div class="ai-js-header">
                  <span class="ai-js-label">JS</span>
                  <div class="ai-js-actions">
                    <button class="btn btn-secondary btn-sm" @click="copyJsCode(msg.parsed.javascript!)">{{ jsCopiedIdx === idx ? '✓ Copied' : 'Copy' }}</button>
                    <button class="btn btn-primary btn-sm" @click="$emit('insert-js', msg.parsed.javascript!)">Open in Script Editor</button>
                  </div>
                </div>
                <pre class="ai-js-code">{{ msg.parsed.javascript }}</pre>
              </div>
              <div v-if="msg.parsed.explanation" class="ai-explanation ai-markdown" v-html="renderMarkdown(msg.parsed.explanation)" />
              <ul v-if="msg.parsed.warnings && msg.parsed.warnings.length > 0" class="ai-warnings">
                <li v-for="(w, wi) in msg.parsed.warnings" :key="wi">{{ w }}</li>
              </ul>
            </template>
            <!-- Plain text fallback — rendered as markdown -->
            <template v-else>
              <div class="ai-plain-text ai-markdown" v-html="renderMarkdown(msg.content)" />
            </template>
          </div>
        </div>

        <div v-if="msg.role === 'error'" class="ai-msg ai-msg-error">
          <div class="ai-bubble ai-bubble-error">
            <strong>Error:</strong> {{ msg.content }}
          </div>
        </div>
      </template>

      <!-- Context truncated notice -->
      <div v-if="contextTruncated" class="ai-notice">
        Early messages were dropped to fit within the model's context window.
      </div>
    </div>

    <!-- Tool detail modal -->
    <teleport to="body">
      <div v-if="toolModal" class="modal-backdrop" @click.self="toolModal = null">
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="modal-title">{{ toolModal.title }}</span>
            <button class="modal-close" @click="toolModal = null" title="Close">✕</button>
          </div>
          <div v-if="toolModal.table" class="modal-table-wrap">
            <table class="modal-table">
              <thead>
                <tr>
                  <th v-for="col in toolModal.table.columns" :key="col">{{ col }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in toolModal.table.rows" :key="ri">
                  <td v-for="col in toolModal.table.columns" :key="col">{{ row[col] ?? '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <pre v-else class="modal-body">{{ toolModal.content }}</pre>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="copyModalContent">{{ modalCopied ? '✓ Copied' : 'Copy' }}</button>
            <button class="btn btn-primary" @click="toolModal = null">Close</button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- Input area -->
    <div class="ai-input-area">
      <textarea
        ref="textareaEl"
        v-model="userInput"
        class="ai-textarea"
        placeholder="Ask a question about your data…"
        rows="3"
        :disabled="loading"
        @keydown.enter.exact.prevent="sendMessage"
        @keydown.enter.shift.exact.prevent="insertNewline"
        @keydown.enter.meta.exact.prevent="insertNewline"
        @keydown.enter.ctrl.exact.prevent="insertNewline"
      />
      <div class="ai-input-footer">
        <span class="ai-hint">↵ to send · ⇧↵ for new line</span>
        <button v-if="loading" class="btn btn-stop btn-sm" @click="stopGeneration">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" style="flex-shrink:0">
            <rect x="5" y="5" width="14" height="14" rx="2"/>
          </svg>
          Stop
        </button>
        <button v-else class="btn btn-primary btn-sm" :disabled="!userInput.trim()" @click="sendMessage">
          Send
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useConnectionStore } from '../stores/connection'
import { buildSelectionContextBlock, type EditorSelectionSnapshot } from '../utils/editorAiContext'

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string)
}

type ParsedResponse = { sql?: string; javascript?: string; explanation?: string; warnings?: string[] }

/**
 * Extract a ParsedResponse from a model reply that may contain markdown preamble
 * before the JSON object (some models prepend explanatory text despite instructions).
 * Finds the outermost { … } block and folds any leading text into explanation.
 */
function extractParsedResponse(text: string): ParsedResponse | null {
  if (!text) { return null }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) { return null }
  let parsed: ParsedResponse
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as ParsedResponse
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) { return null }
  // Fold any markdown preamble before the JSON into the explanation field
  const preamble = text.slice(0, start).trim()
  if (preamble) {
    parsed.explanation = preamble + (parsed.explanation ? '\n\n' + parsed.explanation : '')
  }
  return parsed
}

interface AiMessage {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_confirm' | 'error'
  content: string
  streaming?: boolean
  parsed?: ParsedResponse | null
  toolName?: string
  result?: string
  // tool_confirm only
  confirmReason?: string
  confirmConversationId?: string
  confirmPending?: boolean
  confirmError?: string
  confirmType?: 'ddl' | 'javascript'
}

const conn = useConnectionStore()

const props = defineProps<{
  // Synchronously returns the host view's current editor selection (or null),
  // so it can be embedded in the outgoing chat message. Optional because not
  // every host of AiChatPanel necessarily owns an editor.
  getEditorSelection?: () => EditorSelectionSnapshot | null
}>()

const emit = defineEmits<{
  (e: 'insert-sql', sql: string): void
  (e: 'insert-js', code: string): void
}>()

const messages = ref<AiMessage[]>([])
const userInput = ref('')
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const loading = ref(false)
const contextTruncated = ref(false)
const conversationId = ref(crypto.randomUUID())
const messagesEl = ref<HTMLElement | null>(null)
interface ToolTable { columns: string[]; rows: Record<string, unknown>[] }
const toolModal = ref<{ title: string; content: string; table?: ToolTable } | null>(null)
const modalCopied = ref(false)
const runningSqlIdx = ref(new Set<number>())
const jsCopiedIdx = ref<number | null>(null)
// Incremented on each send and on Stop; lets background IPC completions know
// whether their result is still relevant.
const generationToken = ref(0)

// Provider status shown in the header
const providerSettings = ref<{ provider: string; openaiKeySet: boolean; anthropicKeySet: boolean; mistralKeySet: boolean } | null>(null)

const providerLabels: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  mistral: 'Mistral',
  ollama: 'Ollama',
  litellm: 'LiteLLM'
}

const activeProvider = computed(() => {
  if (!providerSettings.value) {
    return null
  }
  return providerLabels[providerSettings.value.provider] ?? providerSettings.value.provider
})

const activeKeySet = computed(() => {
  const s = providerSettings.value
  if (!s) {
    return false
  }
  if (s.provider === 'openai') {
    return s.openaiKeySet
  }
  if (s.provider === 'anthropic') {
    return s.anthropicKeySet
  }
  if (s.provider === 'mistral') {
    return s.mistralKeySet
  }
  if (s.provider === 'litellm') {
    return true // LiteLLM proxy may not require an API key
  }
  return true // Ollama has no key requirement
})

let unsubChunk: (() => void) | null = null
let unsubToolCall: (() => void) | null = null
let unsubToolResult: (() => void) | null = null
let unsubSettingsChanged: (() => void) | null = null
let unsubConfirmRequest: (() => void) | null = null
let unsubToolExecuting: (() => void) | null = null

function approveConfirm(idx: number): void {
  const msg = messages.value[idx]
  if (!msg || !msg.confirmPending) { return }
  window.api.confirmLlmStatement(msg.confirmConversationId!, true)
  msg.confirmPending = false
  msg.result = 'executing'  // will be updated to 'executed' or 'error' by onToolResult
}

function rejectConfirm(idx: number): void {
  const msg = messages.value[idx]
  if (!msg || !msg.confirmPending) { return }
  window.api.confirmLlmStatement(msg.confirmConversationId!, false)
  msg.confirmPending = false
  msg.result = 'cancelled'
}

function cancelTool(idx: number): void {
  const msg = messages.value[idx]
  if (!msg || msg.result !== 'executing') { return }
  window.api.cancelTool(msg.confirmConversationId!)
  msg.result = 'cancelled'
}

function refreshProviderSettings(): void {
  window.api.getLlmSettings().then((s) => {
    const raw = s as unknown as { provider: string; openaiKeySet?: boolean; anthropicKeySet?: boolean; mistralKeySet?: boolean }
    providerSettings.value = {
      provider: raw.provider ?? 'openai',
      openaiKeySet: raw.openaiKeySet ?? false,
      anthropicKeySet: raw.anthropicKeySet ?? false,
      mistralKeySet: raw.mistralKeySet ?? false
    }
  }).catch(() => { /* ignore */ })
}

onMounted(() => {
  refreshProviderSettings()
  unsubSettingsChanged = window.api.onLlmSettingsChanged(refreshProviderSettings)
  unsubConfirmRequest = window.api.onLlmConfirmRequest((e) => {
    const confirmType = e.type ?? 'ddl'
    messages.value.push({
      role: 'tool_confirm',
      content: e.statement,
      toolName: confirmType === 'javascript' ? 'execute_javascript' : 'execute_ddl',
      confirmReason: e.reason,
      confirmConversationId: e.conversationId,
      confirmPending: true,
      confirmType,
    })
    scrollToBottom()
  })

  // When the main process actually starts the JS worker (post-approval), flip the
  // confirm card from "Executing…" to a cancellable state that shows a Cancel button.
  // The result field stays 'executing' — the Cancel button now appears in the template.
  unsubToolExecuting = window.api.onLlmToolExecuting((e) => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.role === 'tool_confirm' && m.confirmConversationId === e.conversationId && m.result === 'executing') {
        // Already in executing state — the template will show the Cancel button.
        break
      }
    }
  })
  unsubChunk = window.api.onLlmChunk((text) => {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant' && last.streaming) {
      // Existing streaming bubble at the end — append to it
      last.content += text
    } else {
      // No streaming bubble at the end (first chunk, or first chunk after a tool-call
      // card was inserted) — create a new one so it always appears below the tool cards
      messages.value.push({ role: 'assistant', content: text, streaming: true, parsed: null })
    }
    scrollToBottom()
  })

  unsubToolCall = window.api.onLlmToolCall((e) => {
    messages.value.push({
      role: 'tool_call',
      content: JSON.stringify(e.args),
      toolName: e.name,
      result: undefined
    })
    scrollToBottom()
  })

  unsubToolResult = window.api.onLlmToolResult((e) => {
    // Find the last tool_call with this name and attach the result
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'tool_call' && messages.value[i].toolName === e.name && messages.value[i].result === undefined) {
        messages.value[i].result = e.result
        break
      }
    }
    // For execute_ddl and execute_javascript: also update the confirm card with
    // the real execution outcome so it doesn't stay stuck in "Executing…".
    if (e.name === 'execute_ddl' || e.name === 'execute_javascript') {
      for (let i = messages.value.length - 1; i >= 0; i--) {
        const m = messages.value[i]
        if (m.role === 'tool_confirm' && m.result === 'executing') {
          try {
            const parsed = JSON.parse(e.result) as Record<string, unknown>
            if (typeof parsed.error === 'string') {
              m.result = 'error'
              m.confirmError = parsed.error
            } else {
              m.result = 'executed'
              if (e.name === 'execute_ddl') {
                conn.refreshDbInfo()
              }
            }
          } catch {
            m.result = 'executed'
          }
          break
        }
      }
    }
  })
})

onUnmounted(() => {
  unsubChunk?.()
  unsubToolCall?.()
  unsubToolResult?.()
  unsubSettingsChanged?.()
  unsubConfirmRequest?.()
  unsubToolExecuting?.()
})

function startNewConversation(): void {
  generationToken.value++ // invalidate any in-flight request
  loading.value = false
  messages.value = []
  conversationId.value = crypto.randomUUID()
  contextTruncated.value = false
}

function stopGeneration(): void {
  generationToken.value++ // invalidate current in-flight request
  loading.value = false
  // Cancel any pending or executing tool confirmation.
  const pendingMsg = messages.value.find(m => m.role === 'tool_confirm' && (m.confirmPending || m.result === 'executing'))
  if (pendingMsg) {
    if (pendingMsg.confirmPending) {
      // Still waiting for user approval — reject it.
      window.api.confirmLlmStatement(pendingMsg.confirmConversationId!, false)
    } else if (pendingMsg.result === 'executing' && pendingMsg.confirmType === 'javascript') {
      // JS worker is running — terminate it.
      window.api.cancelTool(pendingMsg.confirmConversationId!)
    }
    pendingMsg.confirmPending = false
    pendingMsg.result = 'cancelled'
  }
  // Finalise the streaming bubble with whatever arrived so far
  const idx = findLastStreamingIdx()
  if (idx >= 0) {
    const msg = messages.value[idx]
    msg.streaming = false
    if (msg.content) {
      msg.parsed = extractParsedResponse(msg.content)
    } else {
      messages.value.splice(idx, 1) // nothing was received yet — remove empty bubble
    }
  }
}

function findLastStreamingIdx(): number {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant' && messages.value[i].streaming) {
      return i
    }
  }
  return -1
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function formatToolInput(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    // If there is a single "query" key, surface just the SQL for readability.
    if (Object.keys(args).length === 1 && typeof args.query === 'string') {
      return args.query
    }
    return JSON.stringify(args, null, 2)
  } catch {
    return argsJson
  }
}

function parseToolResult(result: string): { type: 'table'; columns: string[]; rows: Record<string, unknown>[] } | { type: 'error'; message: string } | { type: 'raw'; text: string } {
  try {
    const obj = JSON.parse(result) as Record<string, unknown>
    if (obj && typeof obj === 'object') {
      if (typeof obj.error === 'string') {
        return { type: 'error', message: obj.error }
      }
      if (Array.isArray(obj.columns) && Array.isArray(obj.rows)) {
        return { type: 'table', columns: obj.columns as string[], rows: obj.rows as Record<string, unknown>[] }
      }
    }
    return { type: 'raw', text: JSON.stringify(obj, null, 2) }
  } catch {
    return { type: 'raw', text: result }
  }
}

function toolResultSummary(result: string): string {
  const parsed = parseToolResult(result)
  if (parsed.type === 'table') {
    const r = parsed.rows.length === 1 ? '1 row' : `${parsed.rows.length} rows`
    const c = parsed.columns.length === 1 ? '1 column' : `${parsed.columns.length} columns`
    return `${r} × ${c}`
  }
  if (parsed.type === 'error') {
    return `Error: ${parsed.message}`
  }
  return truncate(parsed.text, 120)
}

function openToolModal(title: string, content: string): void {
  modalCopied.value = false
  toolModal.value = { title, content }
}

function openToolResultModal(toolName: string, result: string): void {
  const parsed = parseToolResult(result)
  modalCopied.value = false
  if (parsed.type === 'table') {
    toolModal.value = { title: `Result — ${toolName}`, content: result, table: { columns: parsed.columns, rows: parsed.rows } }
  } else if (parsed.type === 'error') {
    toolModal.value = { title: `Result — ${toolName}`, content: parsed.message }
  } else {
    toolModal.value = { title: `Result — ${toolName}`, content: parsed.text }
  }
}

async function runSql(idx: number, sql: string): Promise<void> {
  if (runningSqlIdx.value.has(idx)) {
    return
  }
  runningSqlIdx.value = new Set(runningSqlIdx.value).add(idx)
  try {
    const qr = await window.api.executeQuery(sql)
    let resultJson: string
    if (qr.error) {
      resultJson = JSON.stringify({ error: qr.error })
    } else {
      const rows = qr.rows.map((row) => {
        const obj: Record<string, unknown> = {}
        qr.columns.forEach((col, i) => { obj[col] = (row as unknown[])[i] })
        return obj
      })
      resultJson = JSON.stringify({ columns: qr.columns, rows })
    }
    messages.value.push({
      role: 'tool_call',
      toolName: 'execute_sql',
      content: JSON.stringify({ query: sql }),
      result: resultJson
    })
    await nextTick()
    scrollToBottom()
  } finally {
    const next = new Set(runningSqlIdx.value)
    next.delete(idx)
    runningSqlIdx.value = next
  }
}

async function copyModalContent(): Promise<void> {
  if (!toolModal.value) { return }
  await navigator.clipboard.writeText(toolModal.value.content)
  modalCopied.value = true
  setTimeout(() => { modalCopied.value = false }, 2000)
}

async function copyJsCode(code: string): Promise<void> {
  const idx = messages.value.findIndex(m => m.parsed?.javascript === code)
  await navigator.clipboard.writeText(code)
  jsCopiedIdx.value = idx
  setTimeout(() => { jsCopiedIdx.value = null }, 2000)
}

function insertNewline(): void {
  const el = textareaEl.value
  if (!el) {
    userInput.value += '\n'
    return
  }
  const start = el.selectionStart
  const end = el.selectionEnd
  userInput.value = userInput.value.slice(0, start) + '\n' + userInput.value.slice(end)
  nextTick(() => {
    el.selectionStart = el.selectionEnd = start + 1
  })
}

async function sendMessage(): Promise<void> {
  const text = userInput.value.trim()
  if (!text || loading.value) {
    return
  }

  userInput.value = ''
  loading.value = true
  contextTruncated.value = false

  // Capture a token so we can detect if Stop was clicked while waiting.
  const myToken = ++generationToken.value

  messages.value.push({ role: 'user', content: text })

  await scrollToBottom()

  // Build messages array for API (only user/assistant pairs, no tool steps).
  // Snapshot before the call so tool-call cards added during streaming are excluded.
  const apiMessages = messages.value
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // Prepend the current editor selection (if any) to the outgoing message only —
  // NOT to the displayed bubble, and not to earlier history, which already
  // reflects whatever selection existed when it was originally sent (if any).
  // Kept out of the system prompt so that stays stable for provider prompt caching.
  const selection = props.getEditorSelection ? props.getEditorSelection() : null
  const lastIdx = apiMessages.length - 1
  if (lastIdx >= 0) {
    apiMessages[lastIdx] = {
      ...apiMessages[lastIdx],
      content: `${buildSelectionContextBlock(selection)}\n\n${apiMessages[lastIdx].content}`
    }
  }

  try {
    const result = await window.api.llmChat({
      conversationId: conversationId.value,
      messages: apiMessages
    })

    // Discard if the user stopped or started a new message while waiting.
    if (generationToken.value !== myToken) { return }

    // Find the last streaming bubble created dynamically by onLlmChunk.
    // It may be anywhere in the list (after tool-call cards from earlier iterations).
    const lastStreamingIdx = findLastStreamingIdx()

    if (lastStreamingIdx >= 0) {
      // Remove any EARLIER streaming bubbles — they hold partial chunks from
      // pre-tool-call iterations and are superseded by the complete result.reply
      // that lands on the final bubble.
      for (let i = lastStreamingIdx - 1; i >= 0; i--) {
        if (messages.value[i].role === 'assistant' && messages.value[i].streaming) {
          messages.value.splice(i, 1)
        }
      }

      const assistantMsg = messages.value[findLastStreamingIdx()]
      assistantMsg.content = result.reply
      assistantMsg.streaming = false
      assistantMsg.parsed = extractParsedResponse(result.reply)
    } else if (result.reply) {
      // Model returned a reply but never streamed any chunks (e.g. non-streaming path)
      messages.value.push({ role: 'assistant', content: result.reply, streaming: false, parsed: extractParsedResponse(result.reply) })
    }

    if (result.contextTruncated) {
      contextTruncated.value = true
    }
  } catch (err) {
    // Discard if the user stopped or started a new message while waiting.
    if (generationToken.value !== myToken) { return }

    // Remove any streaming bubble that was open, show error bubble instead
    const lastStreamingIdx = findLastStreamingIdx()
    if (lastStreamingIdx >= 0) {
      messages.value.splice(lastStreamingIdx, 1)
    }
    messages.value.push({
      role: 'error',
      content: err instanceof Error ? err.message : String(err)
    })
  } finally {
    // Only reset loading if this generation is still the active one.
    if (generationToken.value === myToken) {
      loading.value = false
      await scrollToBottom()
    }
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}
</script>

<style scoped>
.ai-chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
  overflow: hidden;
}

/* Header */
.ai-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.ai-chat-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-chat-title {
  font-size: 13px;
  font-weight: 600;
}

.ai-provider-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 10px;
  background: #dbeafe;
  color: #1e40af;
  line-height: 1.6;
}

.ai-provider-badge-warn {
  background: #fef9c3;
  color: #854d0e;
}

.ai-chat-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Disclaimer */
.ai-disclaimer {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  background: #fef3c7;
  border-bottom: 1px solid #fde68a;
  padding: 8px 12px;
  font-size: 11px;
  color: #92400e;
  flex-shrink: 0;
}

.ai-disclaimer-list {
  list-style: disc;
  padding-left: 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Messages */
.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
  text-align: center;
  font-size: 13px;
  padding: 24px;
}

.ai-empty-hint {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}

/* Message rows */
.ai-msg {
  display: flex;
  flex-shrink: 0;
}

.ai-msg-user {
  justify-content: flex-end;
}

.ai-msg-assistant,
.ai-msg-error {
  justify-content: flex-start;
}

/* Bubbles */
.ai-bubble {
  max-width: 88%;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.ai-bubble-user {
  background: var(--primary);
  color: #fff;
  border-bottom-right-radius: 3px;
}

.ai-bubble-assistant {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-bottom-left-radius: 3px;
  min-width: 200px;
}

.ai-bubble-error {
  background: #fee2e2;
  border: 1px solid #fca5a5;
  color: #991b1b;
  border-bottom-left-radius: 3px;
}

/* Streaming */
.ai-streaming-text {
  font-family: inherit;
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--text-muted);
}

.ai-cursor {
  display: inline-block;
  animation: blink 0.8s step-end infinite;
  color: var(--primary);
}

@keyframes blink {
  50% { opacity: 0; }
}

/* SQL block */
.ai-sql-block {
  background: #1e1e2e;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 8px;
}

.ai-sql-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: rgba(255,255,255,0.05);
}

.ai-sql-label {
  font-size: 11px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ai-sql-actions {
  display: flex;
  gap: 6px;
}

.ai-sql-code {
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 12px;
  color: #e2e8f0;
  padding: 10px;
  white-space: pre;
  overflow-x: auto;
  margin: 0;
}

/* JavaScript code block (Intent E) — mirrors the SQL block style */
.ai-js-block {
  background: #1e1e2e;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 8px;
}

.ai-js-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: rgba(255,255,255,0.05);
}

.ai-js-label {
  font-size: 11px;
  font-weight: 600;
  color: #f0c674;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ai-js-actions {
  display: flex;
  gap: 6px;
}

.ai-js-code {
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 12px;
  color: #e2e8f0;
  padding: 10px;
  white-space: pre;
  overflow-x: auto;
  margin: 0;
}

/* Explanation & warnings */
.ai-explanation {
  font-size: 13px;
  color: var(--text);
  line-height: 1.5;
  margin-bottom: 4px;
  margin-top: 0;
}

.ai-warnings {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.ai-warnings li {
  font-size: 12px;
  color: #92400e;
  background: #fef3c7;
  border-radius: 4px;
  padding: 4px 8px;
}

.ai-warnings li::before {
  content: '⚠ ';
}

/* Plain text fallback (now markdown-rendered) */
.ai-plain-text {
  font-size: 13px;
  margin: 0;
}

/* Shared markdown styles used by both plain-text and explanation.
   :deep() is required because the content is injected via v-html and
   does not receive Vue's scoped data attribute. */
:deep(.ai-markdown) {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}

:deep(.ai-markdown) > *:first-child { margin-top: 0; }
:deep(.ai-markdown) > *:last-child  { margin-bottom: 0; }

:deep(.ai-markdown) p {
  margin: 0 0 8px;
}

:deep(.ai-markdown) h1,
:deep(.ai-markdown) h2,
:deep(.ai-markdown) h3,
:deep(.ai-markdown) h4 {
  margin: 12px 0 4px;
  font-weight: 600;
  line-height: 1.3;
}
:deep(.ai-markdown) h1 { font-size: 16px; }
:deep(.ai-markdown) h2 { font-size: 15px; }
:deep(.ai-markdown) h3 { font-size: 14px; }
:deep(.ai-markdown) h4 { font-size: 13px; }

:deep(.ai-markdown) ul,
:deep(.ai-markdown) ol {
  margin: 4px 0 8px;
  padding-left: 20px;
}

:deep(.ai-markdown) li {
  margin-bottom: 2px;
}

:deep(.ai-markdown) code {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  background: var(--surface2, rgba(0,0,0,0.06));
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
}

:deep(.ai-markdown) pre {
  background: #1e1e2e;
  border-radius: 6px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 6px 0;
}

:deep(.ai-markdown) pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: #cdd6f4;
}

:deep(.ai-markdown) blockquote {
  margin: 6px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--border);
  color: var(--text-muted);
}

:deep(.ai-markdown) hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 10px 0;
}

/* Markdown tables */
:deep(.ai-markdown) table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
  margin: 8px 0;
  border: 1px solid #d1d5db;
}

:deep(.ai-markdown) th,
:deep(.ai-markdown) td {
  border: 1px solid #d1d5db;
  padding: 5px 10px;
  text-align: left;
  white-space: nowrap;
}

:deep(.ai-markdown) th {
  background: #f3f4f6;
  font-weight: 600;
  color: #374151;
}

:deep(.ai-markdown) tr:nth-child(even) td {
  background: #f9fafb;
}

:deep(.ai-markdown) tr:hover td {
  background: #eff6ff;
}

/* Tool call steps */
.ai-tool-step {
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}

.ai-tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
}

.ai-tool-rows {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.ai-tool-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
}

.ai-tool-row:last-child {
  border-bottom: none;
}

.ai-tool-row-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  flex-shrink: 0;
  width: 38px;
}

.ai-tool-row-error {
  background: color-mix(in srgb, var(--danger, #ef4444) 6%, transparent);
}

.ai-tool-row-error .ai-tool-row-label {
  color: var(--danger, #dc2626);
}

.ai-tool-row-error .ai-tool-snippet code {
  color: var(--danger, #dc2626);
}

.ai-tool-row-error .ai-tool-snippet:hover code {
  color: var(--danger-hover, #b91c1c);
}

.ai-tool-snippet {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  min-width: 0;
}

.ai-tool-snippet code {
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 11px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
  max-width: 380px;
}

.ai-tool-snippet:hover code {
  color: var(--primary);
  text-decoration: underline;
}

/* Tool detail modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: 640px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
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
  font-size: 13px;
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--surface2);
  color: var(--text);
}

.modal-body {
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  padding: 14px 16px;
  overflow-y: auto;
  flex: 1;
  color: var(--text);
  margin: 0;
}

.modal-table-wrap {
  overflow: auto;
  flex: 1;
  padding: 10px 16px;
}

.modal-table {
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
  width: 100%;
}

.modal-table th,
.modal-table td {
  border: 1px solid var(--border);
  padding: 4px 10px;
  text-align: left;
}

.modal-table th {
  background: var(--surface2);
  font-weight: 600;
  color: var(--text);
  position: sticky;
  top: 0;
  z-index: 1;
}

.modal-table tr:nth-child(even) td {
  background: var(--surface2);
}

.modal-table tr:hover td {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.modal-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

/* Context truncated notice */
.ai-notice {
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
  background: #fef3c7;
  border-radius: 4px;
  padding: 4px 8px;
}

/* Input area */
.ai-input-area {
  border-top: 1px solid var(--border);
  padding: 8px 10px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ai-textarea {
  font-family: inherit;
  font-size: 13px;
  resize: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  width: 100%;
  outline: none;
  background: var(--surface);
  color: var(--text);
  transition: border-color 0.15s;
}

.ai-textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 142, 247, 0.15);
}

.ai-textarea:disabled {
  opacity: 0.6;
}

.ai-input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ai-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.btn-stop {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-stop:hover {
  background: #fecaca;
}

/* DDL/DML inline confirmation */
.ai-tool-confirm {
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 40%, var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  margin: 4px 0;
  background: color-mix(in srgb, var(--warning, #f59e0b) 5%, var(--surface));
}

.confirm-reason {
  font-size: 13px;
  color: var(--text);
  margin: 0;
  padding: 8px 12px 0;
  line-height: 1.5;
}

.confirm-sql {
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 12px;
  background: #1e1e2e;
  color: #e2e8f0;
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 8px 12px;
  border-radius: var(--radius-sm);
  max-height: 240px;
  overflow-y: auto;
}

.confirm-actions {
  padding: 0 12px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.confirm-warning {
  font-size: 11px;
  color: var(--danger, #dc2626);
  margin: 0;
  flex: 1;
}

.confirm-btns {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.confirm-outcome {
  padding: 6px 12px 10px;
  font-size: 12px;
  font-weight: 600;
}

.confirm-ok { color: var(--success, #16a34a); }
.confirm-cancelled { color: var(--text-muted); }
.confirm-executing { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
.confirm-error { color: var(--danger, #dc2626); word-break: break-word; }

.btn-danger {
  background: var(--danger, #ef4444);
  color: #fff;
  border: 1px solid var(--danger, #ef4444);
  border-radius: var(--radius-sm);
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-danger:hover {
  background: var(--danger-hover, #dc2626);
  border-color: var(--danger-hover, #dc2626);
}
</style>
