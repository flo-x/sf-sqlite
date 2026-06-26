import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { Mistral } from '@mistralai/mistralai'
import { Ollama } from 'ollama'
import { get_encoding } from 'tiktoken'

// ── Types ─────────────────────────────────────────────────────────────────────

export type LlmProvider = 'openai' | 'anthropic' | 'mistral' | 'ollama' | 'litellm'

export interface LlmSettings {
  provider: LlmProvider
  openaiKey: string
  openaiModel: string              // default 'gpt-4o'
  openaiDeepReason: boolean        // uses o4-mini when true
  anthropicKey: string
  anthropicModel: string           // default 'claude-sonnet-4-5'
  anthropicExtendedThinking: boolean
  mistralKey: string
  mistralModel: string             // default 'codestral-latest'
  ollamaBaseUrl: string            // default 'http://localhost:11434'
  ollamaModel: string              // default 'llama3'
  litellmBaseUrl: string           // default 'http://localhost:4000'
  litellmApiKey: string            // optional — LiteLLM proxy may or may not require one
  litellmModel: string             // forwarded verbatim to the proxy, e.g. 'gpt-4o' or 'claude-3-opus'
  /** Custom system prompt template. Use {{schema}} as the schema placeholder. Empty string = use default. */
  systemPromptTemplate: string
}

export const DEFAULT_SETTINGS: LlmSettings = {
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
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

export interface SendMessageOptions {
  settings: LlmSettings
  systemPrompt: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>
  onChunk: (text: string) => void
  onToolCall: (name: string, args: Record<string, unknown>) => void
  onToolResult: (name: string, result: string) => void
}

export interface SendMessageResult {
  reply: string
  contextTruncated: boolean
  httpLog: HttpLogEntry[]
  /** Set when the LLM call failed; httpLog will still contain the failed entry. */
  error?: string
}

/** One entry per API call made during a sendMessage invocation. */
export interface HttpLogEntry {
  provider: string
  model: string
  /** 0 = first call in this turn; increments each time a tool result is fed back. */
  iteration: number
  /** The system prompt text (schema + instructions). */
  requestSystemPrompt: string
  /** JSON array of conversation messages (user/assistant/tool turns; no system message). */
  requestMessagesJson: string
  /** JSON array of tools sent, or null when no tools were provided. */
  requestToolsJson: string | null
  /** Text content returned by the model; null on a pure tool-call turn. */
  responseContentJson: string | null
  /** JSON array of tool calls returned; null when none. */
  responseToolCallsJson: string | null
  durationMs: number
  /** HTTP status code from the provider (e.g. 400, 429, 500); null on success. */
  httpStatus: number | null
  error: string | null
}

/** Extract an HTTP status code from an unknown SDK error object, if present. */
function getHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') { return null }
  const e = err as Record<string, unknown>
  for (const key of ['status', 'statusCode', 'status_code', 'rawStatusCode']) {
    if (typeof e[key] === 'number') { return e[key] as number }
  }
  return null
}

/**
 * Callback invoked at the end of each provider API call (one per loop iteration).
 * The provider and model fields are injected by sendMessage before the entry is
 * added to the httpLog array.
 */
type OnIterationLog = (entry: Omit<HttpLogEntry, 'provider' | 'model'>) => void

// ── Context window sizes (tokens) ─────────────────────────────────────────────

const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o4-mini': 128_000,
  'o3': 200_000,
  'o3-mini': 128_000,
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'codestral-latest': 32_000,
  'mistral-large-latest': 128_000,
  'mistral-small-latest': 32_000,
  'ollama-default': 8_000,
  // LiteLLM proxies to arbitrary backends; use a conservative default so
  // trimMessages keeps the payload comfortably within unknown model limits.
  'litellm-default': 32_000
}

const REASONING_MODELS = new Set(['o4-mini', 'o3', 'o3-mini', 'o1', 'o1-mini', 'o1-preview'])

/** Maximum number of tool-call / response iterations per sendMessage invocation. */
const MAX_TOOL_ITERATIONS = 10

export function getActiveModel(settings: LlmSettings): string {
  switch (settings.provider) {
    case 'openai':
      return settings.openaiDeepReason ? 'o4-mini' : settings.openaiModel
    case 'anthropic':
      return settings.anthropicModel
    case 'mistral':
      return settings.mistralModel
    case 'ollama':
      return settings.ollamaModel
    case 'litellm':
      return settings.litellmModel
  }
}

function getContextWindow(settings: LlmSettings): number {
  const model = getActiveModel(settings)
  if (settings.provider === 'litellm') {
    // Prefer a known window if the model name happens to match, otherwise fall
    // back to the conservative LiteLLM default.
    return CONTEXT_WINDOWS[model] ?? CONTEXT_WINDOWS['litellm-default']
  }
  return CONTEXT_WINDOWS[model] ?? CONTEXT_WINDOWS['ollama-default']
}

function isReasoningModel(model: string): boolean {
  return REASONING_MODELS.has(model)
}

// ── Token counting ─────────────────────────────────────────────────────────────

let _enc: ReturnType<typeof get_encoding> | null = null

function getEnc(): ReturnType<typeof get_encoding> {
  if (!_enc) {
    _enc = get_encoding('cl100k_base')
  }
  return _enc
}

function countTokens(text: string): number {
  try {
    return getEnc().encode(text).length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

function countMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + countTokens(m.content) + 4, 0)
}

// ── Context window management ──────────────────────────────────────────────────

function trimMessages(
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens: number
): { trimmed: ChatMessage[]; contextTruncated: boolean } {
  const budget = Math.floor(maxTokens * 0.8)
  const systemTokens = countTokens(systemPrompt) + 4

  let contextTruncated = false
  let trimmed = [...messages]

  while (trimmed.length > 1) {
    const total = systemTokens + countMessageTokens(trimmed)
    if (total <= budget) {
      break
    }
    trimmed = trimmed.slice(1)
    contextTruncated = true
  }

  return { trimmed, contextTruncated }
}

// ── System prompt builder ──────────────────────────────────────────────────────

/**
 * The default system prompt template. Use `{{schema}}` as the placeholder where
 * the live DDL schema will be injected at runtime. Users can override this in
 * Settings → System Prompt; the placeholder must be preserved for schema injection.
 */
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are an expert SQLite data analyst and SQL assistant. You help users both analyze data and write SQL queries.

## Database Schema
{{schema}}

## Database Schema (above)
The Database Schema section above contains the full list of tables and their columns as they exist right now in the open database. You should use it to:
- Answer questions about the data structure (table names, column names, types, relationships) without calling execute_sql.
- Understand what data is available before deciding how to approach an analysis or query.
- Infer likely foreign-key relationships from column naming conventions (e.g. a column named "customer_id" in an orders table likely joins to a "customers" table).
Do not query the database for the schema. The schema is provided above, use that information whenever necesary.

## Detecting User Intent

Before responding, identify which of the three intents the user has:

### Intent A — Data Analysis
Signals: "how many", "what is the distribution", "show me", "analyze", "summarize", "find", "what are the top", "is there a trend", "tell me about the data", "what insights", etc.
The user wants **answers and insights**, not a query to copy. The user may also want new tables to be created, or existing data to be modified. You should:
- Use the execute_sql tool proactively to fetch the data you need.
- You can use the execute_ddl tool to run DDL/DML statements to create tables, indexes etc. However, if the user's request can be fulfilled without using DDL/DML, do not use the execute_ddl tool.
- Interpret the results and present findings in plain language.
- Create temporary tables when needed to perform the analysis, but only if impossible to do otherwise.
- Omit the "sql" key from your response — the queries were internal steps, not the deliverable.
- If the analysis is multi-step (e.g. first count totals, then compute ratios), call execute_sql and execute_ddl tools as many times as needed. Do not send two or more statements as one statement to the execute_sql and execute_ddl tools, as SQLite does not support that, but repeat the tool calls as needed.
- The execute_sql tool caps results at 5000 rows. If it returns a "Too many rows" error, the dataset is too large for inline analysis. In that case switch to Intent B: explain the limitation to the user and provide the SQL queries they can run themselves to get the full result.

### Intent B — SQL Query Creation
Signals: "write a query", "give me a query", "how do I select", "create a view", "build a query for", explicit request for SQL syntax, etc.
The user wants **a SQL query to run themselves**. You should:
- Provide a well-formatted SQL query in the "sql" key.
- You may use execute_sql to verify table structure or sample a few rows before writing the final query, but the primary deliverable is the query itself.
- Explain what the query does in "explanation".
- It might be necessary to create DDL/DML statements and not just one query. Do show the necessary DDL/DML statements in the "sql" key.

### Intent C — Schema / Structure Question
Signals: "what tables", "what columns", "what is the structure", "how is X related to Y", "what type is", "describe the schema", "what does this table contain", etc.
The user wants to understand the **shape of the data**, not its content. You should:
- Answer directly from the Database Schema section — do NOT call execute_sql for pure structure questions.
- Describe tables, columns, types, and inferred relationships in plain language.
- Omit the "sql" key unless a query genuinely helps illustrate the answer.

When the intent is ambiguous, prefer Intent C for structural questions, Intent A for factual questions about data content, and Intent B only when the user explicitly asks for SQL.

## Response Format
Always respond with a JSON object in this exact shape:
{
  "sql": "SELECT … (include ONLY for Intent B — omit entirely for Intent A)",
  "explanation": "For Intent A: your analysis findings in plain language. For Intent B: what the query does.",
  "warnings": ["Optional performance, correctness, or data-quality notes — empty array if none"]
}

Do NOT wrap the JSON in markdown code fences.

Whenever a tool was executed but resulted in an error, explain the error to the user in the "explanation" key. Do not attempt to fulfill the user's request, do not attempt to rerun the query, just explain the error.

### STRICT SQLITE SYNTAX RULES:
- ONLY use syntax compatible with SQLite. Do NOT generate PostgreSQL, MySQL, or T-SQL syntax
- DO NOT use RIGHT JOIN or FULL OUTER JOIN. SQLite only supports INNER JOIN and LEFT JOIN
- For Date/Time logic, do not use NOW() or INTERVAL. Use SQLite functions like datetime('now'), date('now'), or strftime()
- Booleans are stored as 1 (True) or 0 (False). Filter using numbers, not literal words (e.g., use 'WHERE active = 1', not 'WHERE active = TRUE')
- Ensure all string comparisons are case-insensitive by using the LIKE operator instead of '=' if matching user-provided text
- Always use explicit column names, never SELECT *
- Always add a LIMIT clause on open-ended exploratory queries
- Use readable aliases (e.g. COUNT(*) AS total_orders)
- Prefer CTEs over deeply nested subqueries for readability
- Never add a semicolon to the end of the query.
- Never send two or more queries as one statement to the execute_sql and execute_ddl tools, as SQLite does not support that.
- Whenever we use a join, always use the table or alias name in the join condition.
- Whenever the select clause contains aggregate functions, always use a group by clause.
- Whenever a column name is used in the query, make sure the column is actually in the table, in the database schema. Never guess the column names.

## Examples

User: "How many orders do we have per status?"
→ Intent A (analysis). Call execute_sql, then report findings.
Assistant: {"explanation":"There are 3 status values: 'pending' (1,204 orders, 42%), 'completed' (1,450 orders, 50%), and 'cancelled' (234 orders, 8%). Completed orders make up the majority.","warnings":[]}

User: "Write a query to show the 10 most recent orders"
→ Intent B (SQL creation).
Assistant: {"sql":"SELECT id, customer_id, status, created_at\\nFROM orders\\nORDER BY created_at DESC\\nLIMIT 10","explanation":"Returns the 10 most recently created orders sorted by creation date descending.","warnings":[]}

User: "Is there a correlation between order value and customer country?"
→ Intent A (analysis). Use execute_sql to aggregate, then interpret.
Assistant: {"explanation":"Average order value by country: US $142, DE $98, FR $110, GB $121. US customers spend 45% more on average than DE customers. The difference is statistically notable given the sample sizes (US: 800 orders, DE: 210 orders).","warnings":["Correlation does not imply causation — regional pricing or product mix differences may explain the gap."]}

User: "What are the distinct status values in orders?"
→ Intent A (analysis). Quick lookup via execute_sql.
Assistant: {"explanation":"The orders table contains 3 distinct status values: pending, completed, cancelled.","warnings":[]}`

/**
 * Build the final system prompt by injecting the live schema DDL into the
 * template. Pass a custom template (from user settings) to override the
 * default; if omitted or blank the built-in DEFAULT_SYSTEM_PROMPT_TEMPLATE is used.
 */
export function buildSystemPrompt(schemaText: string, customTemplate?: string): string {
  const template = (customTemplate && customTemplate.trim()) ? customTemplate : DEFAULT_SYSTEM_PROMPT_TEMPLATE
  return template.replace('{{schema}}', schemaText)
}

// ── Main sendMessage ───────────────────────────────────────────────────────────

export async function sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
  const { settings, systemPrompt, messages, tools, runTool, onChunk, onToolCall, onToolResult } = opts
  const maxTokens = getContextWindow(settings)
  const model = getActiveModel(settings)

  const { trimmed, contextTruncated } = trimMessages(systemPrompt, messages, maxTokens)

  const httpLog: HttpLogEntry[] = []
  const onIterationLog: OnIterationLog = (entry) => {
    httpLog.push({ provider: settings.provider, model, ...entry })
  }

  let reply = ''
  let sendError: string | undefined

  try {
    switch (settings.provider) {
      case 'openai':
        reply = await sendOpenAI(settings, model, systemPrompt, trimmed, tools, runTool, onChunk, onToolCall, onToolResult, onIterationLog)
        break
      case 'anthropic':
        reply = await sendAnthropic(settings, model, systemPrompt, trimmed, tools, runTool, onChunk, onToolCall, onToolResult, onIterationLog)
        break
      case 'mistral':
        reply = await sendMistral(settings, model, systemPrompt, trimmed, tools, runTool, onChunk, onToolCall, onToolResult, onIterationLog)
        break
      case 'ollama':
        reply = await sendOllama(settings, model, systemPrompt, trimmed, tools, runTool, onChunk, onToolCall, onToolResult, onIterationLog)
        break
      case 'litellm':
        reply = await sendLiteLLM(settings, model, systemPrompt, trimmed, tools, runTool, onChunk, onToolCall, onToolResult, onIterationLog)
        break
    }
  } catch (err) {
    // The provider already called onIterationLog with the error entry before
    // re-throwing, so httpLog is already populated.  We capture the error here
    // and return it in the result instead of throwing, guaranteeing the caller
    // always gets the httpLog for persistence.
    sendError = String(err)
  }

  return { reply, contextTruncated, httpLog, error: sendError }
}

// ── Shared tool-call execution ─────────────────────────────────────────────────

interface NormalizedToolCall { id: string; name: string; argsRaw: string }

/**
 * Parse, dispatch, and collect results for a batch of tool calls.
 * Shared by all providers that use id-based tool calls (OpenAI, Anthropic, Mistral, LiteLLM).
 */
async function runToolCalls(
  toolCalls: NormalizedToolCall[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onToolCall: (name: string, args: Record<string, unknown>) => void,
  onToolResult: (name: string, result: string) => void
): Promise<Array<{ id: string; result: string }>> {
  const results: Array<{ id: string; result: string }> = []
  for (const tc of toolCalls) {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(tc.argsRaw) } catch { args = {} }
    onToolCall(tc.name, args)
    const result = await runTool(tc.name, args)
    onToolResult(tc.name, result)
    results.push({ id: tc.id, result })
  }
  return results
}

// ── OpenAI ─────────────────────────────────────────────────────────────────────

async function sendOpenAI(
  settings: LlmSettings,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => void,
  onToolResult: (name: string, result: string) => void,
  onIterationLog: OnIterationLog
): Promise<string> {
  const client = new OpenAI({ apiKey: settings.openaiKey })
  const isReasoning = isReasoningModel(model)

  const baseMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam))
  ]

  const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  let fullReply = ''
  let loopMessages = [...baseMessages]

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: loopMessages,
      stream: true,
      ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
      ...(!isReasoning ? { temperature: 0.1 } : {})
    }

    const t0 = Date.now()
    let currentContent = ''
    const toolCallsAccum: Array<{ index: number; id: string; name: string; argsRaw: string }> = []

    try {
      const stream = await client.chat.completions.create(params)
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          currentContent += delta.content
          onChunk(delta.content)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCallsAccum[idx]) {
              toolCallsAccum[idx] = { index: idx, id: tc.id ?? '', name: tc.function?.name ?? '', argsRaw: '' }
            }
            if (tc.function?.name) { toolCallsAccum[idx].name = tc.function.name }
            if (tc.function?.arguments) { toolCallsAccum[idx].argsRaw += tc.function.arguments }
            if (tc.id) { toolCallsAccum[idx].id = tc.id }
          }
        }
      }
    } catch (err) {
      onIterationLog({
        iteration,
        requestSystemPrompt: systemPrompt,
        requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
        requestToolsJson: openaiTools.length > 0 ? JSON.stringify(openaiTools) : null,
        responseContentJson: null,
        responseToolCallsJson: null,
        durationMs: Date.now() - t0,
        httpStatus: getHttpStatus(err),
        error: String(err)
      })
      throw err
    }

    onIterationLog({
      iteration,
      requestSystemPrompt: systemPrompt,
      requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
      requestToolsJson: openaiTools.length > 0 ? JSON.stringify(openaiTools) : null,
      responseContentJson: currentContent || null,
      responseToolCallsJson: toolCallsAccum.length > 0 ? JSON.stringify(toolCallsAccum) : null,
      durationMs: Date.now() - t0,
      httpStatus: null,
      error: null
    })

    if (toolCallsAccum.length === 0) {
      fullReply = currentContent
      break
    }

    loopMessages = [
      ...loopMessages,
      {
        role: 'assistant',
        content: currentContent || null,
        tool_calls: toolCallsAccum.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsRaw }
        }))
      }
    ]

    const toolResults = await runToolCalls(toolCallsAccum, runTool, onToolCall, onToolResult)
    for (const tr of toolResults) {
      loopMessages.push({ role: 'tool', tool_call_id: tr.id, content: tr.result })
    }
  }

  return fullReply
}

// ── Anthropic ──────────────────────────────────────────────────────────────────

async function sendAnthropic(
  settings: LlmSettings,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => void,
  onToolResult: (name: string, result: string) => void,
  onIterationLog: OnIterationLog
): Promise<string> {
  const client = new Anthropic({ apiKey: settings.anthropicKey })

  const anthropicTools: Anthropic.Tool[] = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema']
  }))

  let fullReply = ''
  let loopMessages: Anthropic.MessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content
  }))

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const t0 = Date.now()
    let currentText = ''
    const toolUses: Array<{ id: string; name: string; inputRaw: string }> = []

    try {
      const stream = client.messages.stream({
        model,
        max_tokens: settings.anthropicExtendedThinking ? 16_000 : 4_096,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            // Prompt caching — system prompt is stable across turns
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: loopMessages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        temperature: 0.1
      } as Parameters<typeof client.messages.stream>[0])

      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          toolUses.push({ id: event.content_block.id, name: event.content_block.name, inputRaw: '' })
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            currentText += event.delta.text
            onChunk(event.delta.text)
          } else if (event.delta.type === 'input_json_delta' && toolUses.length > 0) {
            toolUses[toolUses.length - 1].inputRaw += event.delta.partial_json
          }
        }
      }
    } catch (err) {
      onIterationLog({
        iteration,
        requestSystemPrompt: systemPrompt,
        requestMessagesJson: JSON.stringify(loopMessages),
        requestToolsJson: anthropicTools.length > 0 ? JSON.stringify(anthropicTools) : null,
        responseContentJson: null,
        responseToolCallsJson: null,
        durationMs: Date.now() - t0,
        httpStatus: getHttpStatus(err),
        error: String(err)
      })
      throw err
    }

    onIterationLog({
      iteration,
      requestSystemPrompt: systemPrompt,
      requestMessagesJson: JSON.stringify(loopMessages),
      requestToolsJson: anthropicTools.length > 0 ? JSON.stringify(anthropicTools) : null,
      responseContentJson: currentText || null,
      responseToolCallsJson: toolUses.length > 0 ? JSON.stringify(toolUses) : null,
      durationMs: Date.now() - t0,
      httpStatus: null,
      error: null
    })

    if (toolUses.length === 0) {
      fullReply = currentText
      break
    }

    loopMessages = [
      ...loopMessages,
      {
        role: 'assistant',
        content: [
          ...(currentText ? [{ type: 'text' as const, text: currentText }] : []),
          ...toolUses.map(tu => ({
            type: 'tool_use' as const,
            id: tu.id,
            name: tu.name,
            input: (() => { try { return JSON.parse(tu.inputRaw) } catch { return {} } })()
          }))
        ]
      }
    ]

    const normalizedToolUses = toolUses.map(tu => ({ id: tu.id, name: tu.name, argsRaw: tu.inputRaw }))
    const toolResults = await runToolCalls(normalizedToolUses, runTool, onToolCall, onToolResult)

    loopMessages.push({
      role: 'user',
      content: toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.id,
        content: tr.result
      }))
    })
  }

  return fullReply
}

// ── Mistral ────────────────────────────────────────────────────────────────────

async function sendMistral(
  settings: LlmSettings,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => void,
  onToolResult: (name: string, result: string) => void,
  onIterationLog: OnIterationLog
): Promise<string> {
  const client = new Mistral({ apiKey: settings.mistralKey })

  // Use camelCase field names throughout — the Mistral SDK Zod schema validates
  // against its TypeScript types (toolCalls, toolCallId) and silently strips
  // unknown snake_case keys before sending the HTTP request.
  type MistralMsg = {
    role: string
    content: string
    toolCallId?: string
    toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  }

  const baseMessages: MistralMsg[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ]

  const mistralTools = tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  let fullReply = ''
  let loopMessages = [...baseMessages]

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const t0 = Date.now()
    let currentContent = ''
    // Accumulate by index so that argument fragments sent without an id in
    // later stream chunks are appended to the right entry rather than creating
    // ghost entries with empty id/name that make the tool_calls array invalid.
    const toolCallsAccum: Array<{ id: string; name: string; argsRaw: string }> = []

    try {
      const stream = await client.chat.stream({
        model,
        messages: loopMessages as Parameters<typeof client.chat.stream>[0]['messages'],
        temperature: 0.1,
        ...(mistralTools.length > 0 ? { tools: mistralTools } : {})
      })

      for await (const chunk of stream) {
        const delta = chunk.data.choices[0]?.delta
        if (delta?.content && typeof delta.content === 'string') {
          currentContent += delta.content
          onChunk(delta.content)
        }
        if (delta?.toolCalls) {
          for (const tc of delta.toolCalls) {
            const idx = (tc as unknown as { index?: number }).index ?? toolCallsAccum.length - 1
            const argsFragment = typeof tc.function?.arguments === 'string' ? tc.function.arguments : ''
            if (idx < 0 || !toolCallsAccum[idx] || tc.id) {
              // New tool call — create a fresh slot
              toolCallsAccum.push({
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argsRaw: argsFragment
              })
            } else {
              // Argument fragment for the current (last) tool call
              if (tc.id) { toolCallsAccum[idx].id = tc.id }
              if (tc.function?.name) { toolCallsAccum[idx].name = tc.function.name }
              toolCallsAccum[idx].argsRaw += argsFragment
            }
          }
        }
      }
    } catch (err) {
      onIterationLog({
        iteration,
        requestSystemPrompt: systemPrompt,
        requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
        requestToolsJson: mistralTools.length > 0 ? JSON.stringify(mistralTools) : null,
        responseContentJson: null,
        responseToolCallsJson: null,
        durationMs: Date.now() - t0,
        httpStatus: getHttpStatus(err),
        error: String(err)
      })
      throw err
    }

    onIterationLog({
      iteration,
      requestSystemPrompt: systemPrompt,
      requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
      requestToolsJson: mistralTools.length > 0 ? JSON.stringify(mistralTools) : null,
      responseContentJson: currentContent || null,
      responseToolCallsJson: toolCallsAccum.length > 0 ? JSON.stringify(toolCallsAccum) : null,
      durationMs: Date.now() - t0,
      httpStatus: null,
      error: null
    })

    if (toolCallsAccum.length === 0) {
      fullReply = currentContent
      break
    }

    // Filter out any ghost entries (empty id) before using the array
    const validCalls = toolCallsAccum.filter(tc => tc.id !== '')

    loopMessages = [
      ...loopMessages,
      {
        role: 'assistant',
        content: currentContent,
        toolCalls: validCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsRaw }
        }))
      }
    ]

    const toolResults = await runToolCalls(validCalls, runTool, onToolCall, onToolResult)
    for (const tr of toolResults) {
      loopMessages.push({ role: 'tool', toolCallId: tr.id, content: tr.result })
    }
  }

  return fullReply
}

// ── Ollama ─────────────────────────────────────────────────────────────────────

async function sendOllama(
  settings: LlmSettings,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => void,
  onToolResult: (name: string, result: string) => void,
  onIterationLog: OnIterationLog
): Promise<string> {
  const client = new Ollama({ host: settings.ollamaBaseUrl })

  type OllamaMsg = { role: string; content: string }

  const baseMessages: OllamaMsg[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ]

  const ollamaTools = tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  let fullReply = ''
  let loopMessages = [...baseMessages]

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const t0 = Date.now()
    let currentContent = ''
    let toolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = []

    try {
      const stream = await client.chat({
        model,
        messages: loopMessages,
        stream: true,
        options: { temperature: 0.1 },
        ...(ollamaTools.length > 0 ? { tools: ollamaTools } : {})
      })

      for await (const chunk of stream) {
        if (chunk.message?.content) {
          currentContent += chunk.message.content
          onChunk(chunk.message.content)
        }
        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          toolCalls = chunk.message.tool_calls as typeof toolCalls
        }
      }
    } catch (err) {
      onIterationLog({
        iteration,
        requestSystemPrompt: systemPrompt,
        requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
        requestToolsJson: ollamaTools.length > 0 ? JSON.stringify(ollamaTools) : null,
        responseContentJson: null,
        responseToolCallsJson: null,
        durationMs: Date.now() - t0,
        httpStatus: getHttpStatus(err),
        error: String(err)
      })
      throw err
    }

    onIterationLog({
      iteration,
      requestSystemPrompt: systemPrompt,
      requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
      requestToolsJson: ollamaTools.length > 0 ? JSON.stringify(ollamaTools) : null,
      responseContentJson: currentContent || null,
      responseToolCallsJson: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      durationMs: Date.now() - t0,
      httpStatus: null,
      error: null
    })

    if (!toolCalls || toolCalls.length === 0) {
      fullReply = currentContent
      break
    }

    loopMessages = [...loopMessages, { role: 'assistant', content: currentContent }]

    const toolResults: Array<{ name: string; result: string }> = []
    for (const tc of toolCalls) {
      const name = tc.function.name
      const args = tc.function.arguments ?? {}
      onToolCall(name, args)
      const result = await runTool(name, args)
      onToolResult(name, result)
      toolResults.push({ name, result })
    }

    for (const tr of toolResults) {
      loopMessages.push({ role: 'tool', content: tr.result })
    }
  }

  return fullReply
}

// ── LiteLLM (OpenAI-compatible proxy) ─────────────────────────────────────────

async function sendLiteLLM(
  settings: LlmSettings,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => void,
  onToolResult: (name: string, result: string) => void,
  onIterationLog: OnIterationLog
): Promise<string> {
  const client = new OpenAI({
    apiKey: settings.litellmApiKey || 'no-key', // LiteLLM proxy may not require a key
    baseURL: settings.litellmBaseUrl
  })

  const baseMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam))
  ]

  const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))

  let fullReply = ''
  let loopMessages = [...baseMessages]

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: loopMessages,
      stream: true,
      temperature: 0.1,
      ...(openaiTools.length > 0 ? { tools: openaiTools } : {})
    }

    const t0 = Date.now()
    let currentContent = ''
    const toolCallsAccum: Array<{ index: number; id: string; name: string; argsRaw: string }> = []

    try {
      const stream = await client.chat.completions.create(params)
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          currentContent += delta.content
          onChunk(delta.content)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCallsAccum[idx]) {
              toolCallsAccum[idx] = { index: idx, id: tc.id ?? '', name: tc.function?.name ?? '', argsRaw: '' }
            }
            if (tc.function?.name) { toolCallsAccum[idx].name = tc.function.name }
            if (tc.function?.arguments) { toolCallsAccum[idx].argsRaw += tc.function.arguments }
            if (tc.id) { toolCallsAccum[idx].id = tc.id }
          }
        }
      }
    } catch (err) {
      onIterationLog({
        iteration,
        requestSystemPrompt: systemPrompt,
        requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
        requestToolsJson: openaiTools.length > 0 ? JSON.stringify(openaiTools) : null,
        responseContentJson: null,
        responseToolCallsJson: null,
        durationMs: Date.now() - t0,
        httpStatus: getHttpStatus(err),
        error: String(err)
      })
      throw err
    }

    onIterationLog({
      iteration,
      requestSystemPrompt: systemPrompt,
      requestMessagesJson: JSON.stringify(loopMessages.slice(1)),
      requestToolsJson: openaiTools.length > 0 ? JSON.stringify(openaiTools) : null,
      responseContentJson: currentContent || null,
      responseToolCallsJson: toolCallsAccum.length > 0 ? JSON.stringify(toolCallsAccum) : null,
      durationMs: Date.now() - t0,
      httpStatus: null,
      error: null
    })

    if (toolCallsAccum.length === 0) {
      fullReply = currentContent
      break
    }

    loopMessages = [
      ...loopMessages,
      {
        role: 'assistant',
        content: currentContent || null,
        tool_calls: toolCallsAccum.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsRaw }
        }))
      }
    ]

    const toolResults = await runToolCalls(toolCallsAccum, runTool, onToolCall, onToolResult)
    for (const tr of toolResults) {
      loopMessages.push({ role: 'tool', tool_call_id: tr.id, content: tr.result })
    }
  }

  return fullReply
}

// ── Tool definitions ───────────────────────────────────────────────────────────

export const EXECUTE_SQL_TOOL: ToolDefinition = {
  name: 'execute_sql',
  description:
    'Run a read-only SELECT query against the SQLite database and return the results as JSON rows. ' +
    'Use this when you need to inspect actual data values, sample rows, or compute aggregations to answer the user\'s question.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A valid SQLite SELECT statement.'
      }
    },
    required: ['query']
  }
}

export const EXECUTE_DDL_TOOL: ToolDefinition = {
  name: 'execute_ddl',
  description:
    'Run a single DDL or DML statement (CREATE TABLE, INSERT, UPDATE, ALTER, …) ' +
    'against the SQLite database. Use this only when strictly necessary for answering the user\'s question. ' +
    'Do not send two or more statements as one statement to the execute_sql and execute_ddl tools, as SQLite does not support that.',
  parameters: {
    type: 'object',
    properties: {
      statement: {
        type: 'string',
        description: 'The SQL statement to execute (DDL or DML).'
      },
      reason: {
        type: 'string',
        description: 'A short plain-language explanation of what this statement does and why.'
      }
    },
    required: ['statement', 'reason']
  }
}

// ── Model listing ──────────────────────────────────────────────────────────────

/**
 * Fetch the list of available model IDs from the configured provider's API.
 * The `settings` object must contain plaintext credentials (same as sendMessage).
 */
export async function listModels(settings: LlmSettings): Promise<string[]> {
  switch (settings.provider) {
    case 'openai': {
      const client = new OpenAI({ apiKey: settings.openaiKey })
      const page = await client.models.list()
      return page.data
        .map(m => m.id)
        .filter(id => /^(gpt-|o1|o3|o4-|chatgpt-)/.test(id))
        .sort()
    }

    case 'anthropic': {
      const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          'x-api-key': settings.anthropicKey,
          'anthropic-version': '2023-06-01'
        }
      })
      if (!resp.ok) {
        throw new Error(`Anthropic models API returned HTTP ${resp.status}`)
      }
      const json = (await resp.json()) as { data: Array<{ id: string }> }
      return json.data.map(m => m.id).sort()
    }

    case 'mistral': {
      const client = new Mistral({ apiKey: settings.mistralKey })
      const resp = await client.models.list()
      return (resp.data ?? [])
        .map((m) => (m as unknown as { id?: string }).id ?? '')
        .filter(Boolean)
        .sort()
    }

    case 'ollama': {
      const client = new Ollama({ host: settings.ollamaBaseUrl })
      const resp = await client.list()
      return resp.models.map(m => m.model).sort()
    }

    case 'litellm': {
      const client = new OpenAI({
        apiKey: settings.litellmApiKey || 'no-key',
        baseURL: settings.litellmBaseUrl
      })
      const page = await client.models.list()
      return page.data.map(m => m.id).sort()
    }

    default:
      return []
  }
}
