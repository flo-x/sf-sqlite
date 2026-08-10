import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { Mistral } from '@mistralai/mistralai'
import { Ollama } from 'ollama'
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
  /** Schema-only trailing portion of systemPrompt — i.e. systemPrompt with this
   *  exact suffix removed leaves the DB-independent instructions block. Used
   *  only by the Anthropic path to place the schema in its own cache_control
   *  breakpoint, separate from the (much larger, stable) instructions block. */
  systemPromptSchema: string
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

function countTokens(text: string): number {
  return Math.ceil(text.length / 4)
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
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are an expert SQLite data analyst and SQL assistant. You help users both analyze data and write SQL queries, and sometimes JavaScript code for data processing.

## Database Schema
The full list of tables and their columns, as they exist right now in the open database, is provided in the "## Live Database Schema" section at the very end of this system prompt. You should use it to:
- Answer questions about the data structure (table names, column names, types, relationships) without calling execute_sql.
- Understand what data is available before deciding how to approach an analysis or query.
- Infer likely foreign-key relationships from column naming conventions (e.g. a column named "customer_id" in an orders table likely joins to a "customers" table).
Do not query the database for the schema. It is provided at the end of this prompt — use that information whenever necessary.

## Editor Context Tools

The user may be working in the SQL Query Editor or the JavaScript Script Editor while talking to you, and may refer to what's on their screen instead of pasting it into the chat.

**Current selection is provided inline, automatically.** Every user message is preceded by a \`<user_selection>\` block reflecting their editor selection at the moment they sent it. It has one of three states:
- \`status="none"\` — nothing is selected right now. If the user refers to "this" or "the selected part" while this is the state, tell them nothing appears to be selected, or fall back to \`get_editor_content\` if their intent seems to be "the whole thing".
- \`status="present"\` — the selected text is included directly inside the block (this only happens for selections under ~2 KB). Use it only if it's actually relevant to the user's message below it; otherwise ignore it.
- \`status="too_large"\` — there is a selection, but it was too big to include inline. Call the \`get_editor_selection\` tool yourself if you actually need its contents; otherwise ignore it.
The block's \`source\`/\`language\` attributes tell you whether it came from the Query Editor (SQL) or the Script Editor (JavaScript).

**Tools, for everything the inline block doesn't cover:**
- \`get_editor_selection\` — fetches the current selection directly. Use this when the inline block says \`status="too_large"\` and you need the content, or when you need to re-check the selection later in a multi-step task (the inline block only reflects the selection at send time). Returns an empty string if nothing is selected.
- \`get_editor_content\` — gets the full editor contents (active tab only, if the Query Editor has multiple tabs open). Use this when the user says something like "my query", "my script", "what I have so far", or "the whole thing".
- Both tools' results also carry \`source\`/\`language\` fields, same as the inline block.
- If neither editor is currently open (e.g. the user is on another screen), these tools return an error — in that case, ask the user to paste the relevant text instead.

## Detecting User Intent

Before responding, identify which of the following intents the user has:

### Intent A — Data Analysis
Signals: "how many", "what is the distribution", "show me", "analyze", "summarize", "find", "what are the top", "is there a trend", "tell me about the data", "what insights", "clean up", "normalise", "transform", "process row by row", "apply regex", etc.
The user wants **answers and insights**, not a query to copy. The user may also want new tables to be created, or existing data to be modified. You should:
- Use the execute_sql tool proactively to fetch the data you need.
- You can use the execute_ddl tool to run DDL/DML statements to create tables, indexes, bulk updates etc. However, if the user's request can be fulfilled without using DDL/DML, do not use the execute_ddl tool.
- Interpret the results and present findings in plain language.
- Create temporary tables when needed to perform the analysis, but only if impossible to do otherwise.
- Omit the "sql" key from your response — the queries were internal steps, not the deliverable.
- If the analysis is multi-step (e.g. first count totals, then compute ratios), call execute_sql and execute_ddl tools as many times as needed. Do not send two or more statements as one statement to the execute_sql and execute_ddl tools, as SQLite does not support that, but repeat the tool calls as needed.
- The execute_sql tool caps results at 5000 rows. If it returns a "Too many rows" error, the dataset is too large for inline analysis. In that case switch to Intent B: explain the limitation to the user and provide the SQL queries they can run themselves to get the full result.

**JavaScript as a last resort within Intent A:**
If a step in the analysis or transformation genuinely cannot be expressed in SQL or DDL/DML, you may use execute_javascript. Use it only when SQL is provably insufficient — for example, SQLite lacks a built-in function you need, or the logic requires iterative per-row computation that cannot be expressed as a single SQL statement. Aggregations, filtering, joins, bulk INSERT/UPDATE, and CREATE TABLE AS SELECT must always use SQL, never JavaScript.
Before calling execute_javascript, you MUST state in the "explanation" field exactly why SQL/DDL is insufficient, naming the specific limitation (e.g. "SQLite has no built-in regex replace function, so row-by-row normalisation of the phone column requires JavaScript"). This explanation is shown to the user before they decide whether to approve the script.
The available API is described in the **JavaScript API: AI-Executed Scripts** section below.
If the script produces data, it MUST write it to a new SQLite table (CREATE TABLE + INSERT) rather than printing rows to console. Use console.log only for brief status messages (row counts, success/error confirmation). After the script completes, call execute_sql to query the result table and show the user the output. Name result tables with a clear prefix such as "ai_" (e.g. "ai_phone_normalised", "ai_revenue_by_month").

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

### Intent D — JavaScript Code Generation
Signals: "write me a script", "give me JavaScript", "create a JS snippet", "generate JavaScript code", explicit requests for JS code as a deliverable.
The user wants **JavaScript code to run themselves**, not an autonomous execution. You should:
- Generate the code using the full API described in the **JavaScript API: User-Written Scripts** section below, which includes \`db.*\`, \`console.*\`, \`db.progress()\`, and the \`jobs.*\` API.
- Do NOT call execute_javascript — return the code in the "javascript" key instead.
- The value of the "javascript" key MUST be the raw code as a plain JSON string — no markdown code fences (no \`\`\` blocks), no language tags, just the source code itself.
- Do NOT put the code in the "explanation" field, in a markdown block, or anywhere other than the "javascript" key.
- Explain what the script does in "explanation".
- Never combine "javascript" and "sql" keys in the same response.

When the intent is ambiguous, prefer Intent C for structural questions, Intent A for factual questions about data content or transformation requests, and Intent B only when the user explicitly asks for SQL.

## JavaScript API: User-Written Scripts

Use this API when generating JavaScript code for the user to run themselves (Intent D). Scripts run in a Node.js Worker thread. Top-level \`await\` is supported.

### Database API — \`db\`

\`db.query(sql, params?)\` → \`{ columns: string[], rows: unknown[][] }\`
Execute a SELECT and return all matching rows in memory. \`columns\` is the ordered list of column names; each element of \`rows\` is a plain array of values in the same order. \`params\` is an optional array of positional \`?\` bindings.

\`db.query(sql, params?, { asObjects: true })\` → \`Record<string, unknown>[]\`
Same as above, but returns an array of plain objects keyed by column name instead of arrays. Convenient when you want to access fields by name (\`row.revenue\`) rather than by index. Pass \`undefined\` as \`params\` when you have no bindings: \`db.query(sql, undefined, { asObjects: true })\`.

\`db.execute(sql, params?)\` → \`{ changes: number, lastInsertRowid: number }\`
Execute a single INSERT / UPDATE / DELETE or DDL statement. Returns the number of rows affected and the rowid of the last INSERT (0 when not applicable).

\`db.iterate(sql, params?)\` → \`IterableIterator<Record<string, unknown>>\`
Return a lazy, row-by-row cursor. Each iteration yields a plain object \`{ columnName: value, … }\`. Use this for large tables to avoid loading all rows into memory at once.

\`db.transaction(fn)\` → \`void\`
Wrap the synchronous function \`fn\` in a BEGIN / COMMIT transaction. Batching many writes inside one transaction is 10–100× faster than individual statements.

\`db.progress(value, total?, label?)\` → \`void\`
Report progress to the UI progress bar.
- \`db.progress(50)\` — set the bar to 50 %.
- \`db.progress(done, total)\` — percentage is computed automatically.
- \`db.progress(done, total, 'Processing rows…')\` — with an optional label shown next to the bar.

### Jobs API — \`jobs\`

The \`jobs\` object lets scripts trigger configured download and writeback jobs by their display label and \`await\` their completion.

**Identifying a job — use the display label shown in the UI job list:**
- Standard download job: \`"<SfObject>: <jobName>"\` — e.g. \`"Account: extract"\` or \`"Contact: nightly sync"\`
- SOQL download job with a name: \`"SOQL: <jobName>"\` — e.g. \`"SOQL: custom query"\`
- SOQL download job without a name: \`"SOQL"\`
- Job with no name (object only): just \`"<SfObject>"\` — e.g. \`"Account"\`
- Writeback job: \`"<SfObject>: <jobName>"\` — e.g. \`"Account: writeback"\`

\`jobs.list()\` → \`Promise<JobListEntry[]>\`
Return the full list of configured jobs. Each entry has:
- \`label: string\` — the identifier to pass to \`runDownload\` / \`runWriteback\`
- \`type: 'extract' | 'writeback'\`
- \`sfObject: string\` — Salesforce API object name (e.g. \`"Account"\`), or \`"SOQL"\` for raw-SOQL extract jobs
- \`destTable?: string\` — (extract only) target SQLite table name
- \`operation?: string\` — (writeback only) DML action: \`"insert"\`, \`"update"\`, \`"upsert"\`, \`"delete"\`, or \`"undelete"\`
- \`api?: 'REST' | 'Bulk'\` — (writeback only) API used to push records

\`jobs.runDownload(label)\` → \`Promise<{ status: string, rowsSource: number, rowsSucceeded: number }>\`
Run the download (extract) job identified by \`label\` and wait until it finishes. Throws if the job fails or is cancelled.
- \`status\` — \`"success"\` or \`"partial"\`
- \`rowsSource\` — rows fetched from Salesforce
- \`rowsSucceeded\` — rows written into the SQLite destination table (equals \`rowsSource\` on success)

\`jobs.runWriteback(label)\` → \`Promise<{ _runId: string, status: string, rowsSource: number, rowsSucceeded: number, rowsFailed: number, execTable: string | null }>\`
Run the writeback job identified by \`label\` and wait until it finishes. Keep the returned result object to pass to the helpers below.
- \`status\` — \`"success"\`, \`"partial"\`, \`"error"\`, or \`"cancelled"\`
- \`rowsSource\` — total source rows in the SQL query
- \`rowsSucceeded\` — rows successfully pushed to Salesforce
- \`rowsFailed\` — rows that failed
- \`execTable\` — name of the SQLite table holding every source row with its outcome columns (\`__sf_id\`, \`__status\`, \`__error\`); query it with \`db.query(\`SELECT * FROM \${result.execTable}\`)\`. For REST API jobs the table always exists after the run. For Bulk API jobs it contains only failed rows and is \`null\` when there are no failures.

\`jobs.getFailedRows(result)\` → \`Promise<{ failedRows: Array<{ index: number, message: string, row: Record<string, unknown> }>, keyFields: Array<{ sfField: string, sqlCol: string, label: string }> }>\`
Fetch the per-row failure details from a previous \`runWriteback\` result. Call this only when \`rowsFailed > 0\`. Alternatively, query \`result.execTable\` directly with \`db.query()\` for full access to all rows and their statuses.

\`jobs.updateTableWithIds(result, opts)\` → \`Promise<{ updated: number, idColCreated: boolean, indexCreated: boolean }>\`
After a successful writeback, back-fill the Salesforce record IDs that were assigned during the upsert into a local table. \`opts\` must be \`{ sfKeyField: string, targetTable: string, tableKeyCol: string, idColumnName: string }\`.

### Console API — \`console\`

\`console.log(...args)\`, \`console.warn(...args)\`, \`console.error(...args)\` — all arguments are stringified and streamed to the script output panel in real time.

### Environment

- Top-level \`await\` is supported.
- Node.js globals (\`process\`, \`Buffer\`, \`crypto\`, etc.) are available.
- \`fetch()\` is available if the Node.js version supports it.
- There is no DOM: \`document\`, \`window\`, and all browser APIs are undefined.

## JavaScript API: AI-Executed Scripts

Use this API when the AI calls the \`execute_javascript\` tool itself (Intent A, last resort). The script runs in a stricter isolated environment using a null-prototype \`vm\` context. Only \`db\` and \`console\` are exposed — \`jobs.*\` and \`db.progress()\` are not available.

### Database API — \`db\`

\`db.query(sql, params?)\` → \`{ columns: string[], rows: unknown[][] }\`
Execute a SELECT and return all matching rows in memory. \`columns\` is the ordered list of column names; each element of \`rows\` is an array of values in the same order.

\`db.execute(sql, params?)\` → \`{ changes: number, lastInsertRowid: number }\`
Execute a single INSERT / UPDATE / DELETE or DDL statement.

\`db.iterate(sql, params?)\` → \`IterableIterator<Record<string, unknown>>\`
Lazy row-by-row cursor; each iteration yields \`{ columnName: value, … }\`. Use for large tables.

\`db.transaction(fn)\` → \`void\`
Wrap \`fn\` in a BEGIN / COMMIT transaction. Essential for batching many writes efficiently.

### Console API — \`console\`

\`console.log(...args)\`, \`console.warn(...args)\`, \`console.error(...args)\` — output is captured and returned as the tool result. Console output is capped at 200 lines; use it only for brief status messages (row counts, success / error confirmation). Never print large datasets to the console — write them to a database table instead.

### Environment

- Top-level \`await\` is supported.
- \`process\`, \`fetch()\`, \`import()\`, and \`require()\` are **not** available.
- There is no DOM: \`document\`, \`window\`, and all browser APIs are undefined.
- \`db.progress()\` and the \`jobs.*\` API are **not** available.
- Scripts run in a null-prototype \`vm\` context; prototype-chain escapes to Node.js globals are blocked.

## Response Format
Always respond with a JSON object in this exact shape:
{
  "sql": "SELECT … (Intent B only — omit for all other intents)",
  "javascript": "const rows = … (Intent D only — omit for all other intents, never combine with sql)",
  "explanation": "For Intent A: analysis findings (and, if JavaScript was used, why SQL was insufficient). For Intent B: what the query does. For Intent D: what the script does.",
  "warnings": ["Optional performance, correctness, or data-quality notes — empty array if none"]
}

CRITICAL OUTPUT RULES — violations break the UI parser:
- Your ENTIRE response MUST be a single JSON object. Start with { and end with }.
- Do NOT write any text, sentence, or explanation before or after the JSON object.
- Do NOT wrap the JSON in markdown code fences or any other formatting.
- Do NOT use emojis anywhere in your responses.

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
Assistant: {"explanation":"The orders table contains 3 distinct status values: pending, completed, cancelled.","warnings":[]}

User: "Normalise the phone column in contacts — strip all non-digit characters from every row"
→ Intent A (analysis/transformation). SQL cannot do this; execute_javascript is the last resort.
Assistant (before calling execute_javascript): {"explanation":"SQLite has no built-in function to strip non-digit characters from a string, so SQL alone cannot perform this transformation. I will run a JavaScript script that reads every row, applies a regex replace, and writes the results to a new table 'ai_phone_normalised'. I will then query it so you can review the output.","warnings":[]}
The script should: CREATE TABLE ai_phone_normalised, iterate over contacts, insert cleaned rows, console.log("Created table 'ai_phone_normalised' with N rows"). Then call execute_sql("SELECT * FROM ai_phone_normalised LIMIT 20") to show results.

User: "Write me a JavaScript script that computes revenue by month and saves it to a table"
→ Intent D (JavaScript code generation). User explicitly asked for a script.

WRONG (never do this — code embedded in markdown inside explanation):
{"explanation":"Here is the script:\n\`\`\`javascript\ndb.execute('CREATE TABLE ...')\n\`\`\`","warnings":[]}

CORRECT (raw code string in the javascript key, no fences):
{"javascript":"db.execute('DROP TABLE IF EXISTS ai_revenue_by_month')\ndb.execute('CREATE TABLE ai_revenue_by_month (month TEXT, total_revenue REAL, order_count INTEGER)')\nconst { rows } = db.query(\"SELECT strftime('%Y-%m', created_at) AS month, SUM(amount) AS total, COUNT(*) AS cnt FROM orders GROUP BY month ORDER BY month\")\ndb.transaction(() => {\n  for (const [month, total, cnt] of rows) {\n    db.execute('INSERT INTO ai_revenue_by_month VALUES (?, ?, ?)', [month, total, cnt])\n  }\n})\nconsole.log('Created table ai_revenue_by_month with ' + rows.length + ' rows')","explanation":"Creates a table ai_revenue_by_month with one row per calendar month. Run this script, then query SELECT * FROM ai_revenue_by_month to review the results.","warnings":[]}

## Live Database Schema
{{schema}}`

export interface SystemPromptParts {
  /**
   * Everything before the {{schema}} placeholder — stable across turns and
   * across databases, since it never depends on live schema state. This is the
   * part worth keeping as a fixed prefix for provider-side prompt caching
   * (OpenAI's automatic prefix caching, Anthropic's cache_control breakpoints).
   */
  instructions: string
  /**
   * The literal schema text (plus any template text placed after the
   * placeholder, for custom templates) — changes whenever the open database's
   * structure changes.
   */
  schema: string
}

/**
 * Splits a system prompt template around its {{schema}} placeholder so callers
 * can keep the large, DB-independent instructions block separate from the
 * volatile live schema. DEFAULT_SYSTEM_PROMPT_TEMPLATE places {{schema}} at the
 * very end for exactly this reason — see the "Live Database Schema" section.
 * Pass a custom template (from user settings) to override the default; if
 * omitted or blank the built-in DEFAULT_SYSTEM_PROMPT_TEMPLATE is used.
 */
export function buildSystemPromptParts(schemaText: string, customTemplate?: string): SystemPromptParts {
  const template = (customTemplate && customTemplate.trim()) ? customTemplate : DEFAULT_SYSTEM_PROMPT_TEMPLATE
  const placeholderIdx = template.indexOf('{{schema}}')
  if (placeholderIdx === -1) {
    // No placeholder — e.g. a custom template that omits {{schema}} entirely.
    // Mirrors the old template.replace('{{schema}}', ...) behavior, which was a
    // no-op in this case: the schema is simply not included anywhere.
    return { instructions: template, schema: '' }
  }
  const before = template.slice(0, placeholderIdx)
  const after = template.slice(placeholderIdx + '{{schema}}'.length)
  return { instructions: before, schema: schemaText + after }
}

/** Build the final, single-string system prompt by injecting the live schema
 * DDL into the template. Used by every provider except Anthropic, which uses
 * buildSystemPromptParts() directly to place the schema in its own cache
 * breakpoint instead. */
export function buildSystemPrompt(schemaText: string, customTemplate?: string): string {
  const { instructions, schema } = buildSystemPromptParts(schemaText, customTemplate)
  return instructions + schema
}

// ── Main sendMessage ───────────────────────────────────────────────────────────

export async function sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
  const { settings, systemPrompt, systemPromptSchema, messages, tools, runTool, onChunk, onToolCall, onToolResult } = opts
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
        reply = await sendAnthropic(settings, model, systemPrompt, systemPromptSchema, trimmed, tools, runTool, onChunk, onToolCall, onToolResult, onIterationLog)
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
  systemPromptSchema: string,
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

  // Split into two cache breakpoints: the (large, DB-independent) instructions
  // block stays cached across virtually every turn and every conversation,
  // while the schema block — small but changes whenever the open database's
  // structure does — gets its own breakpoint so a schema change only misses
  // the cache for that one block instead of invalidating the whole prompt.
  const systemPromptInstructions = systemPrompt.slice(0, systemPrompt.length - systemPromptSchema.length)
  const anthropicSystem = systemPromptSchema
    ? [
        { type: 'text' as const, text: systemPromptInstructions, cache_control: { type: 'ephemeral' as const } },
        { type: 'text' as const, text: systemPromptSchema, cache_control: { type: 'ephemeral' as const } }
      ]
    : [{ type: 'text' as const, text: systemPromptInstructions, cache_control: { type: 'ephemeral' as const } }]

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
        system: anthropicSystem,
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

export const GET_EDITOR_CONTENT_TOOL: ToolDefinition = {
  name: 'get_editor_content',
  description:
    'Get the full contents of the editor the user currently has open — the SQL in the Query Editor, or the code in the Script Editor. ' +
    'If the Query Editor has multiple tabs open, only the active tab is returned. ' +
    'Use this when the user refers to "my query", "my script", "what I have", or similar, instead of asking them to paste it.',
  parameters: { type: 'object', properties: {}, required: [] }
}

export const GET_EDITOR_SELECTION_TOOL: ToolDefinition = {
  name: 'get_editor_selection',
  description:
    'Get the text currently selected/highlighted by the user in the Query Editor or Script Editor. ' +
    'Returns an empty string if nothing is selected. ' +
    'Note: small selections (under ~2 KB) are already included inline in the user\'s message as a <user_selection> block — ' +
    'only call this tool when that block says status="too_large", or when you need to re-check the selection later in a multi-step task.',
  parameters: { type: 'object', properties: {}, required: [] }
}

export const EXECUTE_JAVASCRIPT_TOOL: ToolDefinition = {
  name: 'execute_javascript',
  description:
    'Run a JavaScript snippet in a restricted Worker thread with read/write access to the open SQLite database. ' +
    'Use ONLY when the task genuinely cannot be expressed in SQL or DDL/DML — if any combination of ' +
    'execute_sql and execute_ddl can solve the problem, those must be used instead. ' +
    'Before calling this tool, state in the explanation field why SQL/DDL is insufficient. ' +
    'Available APIs: db.query(sql, params?), db.execute(sql, params?), db.iterate(sql, params?), ' +
    'db.transaction(fn), console.log/warn/error(). ' +
    'Top-level await is supported. ' +
    'Results must be written to a new database table using db.execute() — do NOT return large datasets via console.log. ' +
    'Use console.log only for brief status messages (e.g. row counts, success/error confirmation). ' +
    'After the script completes, query the result table with execute_sql to show the user the output.',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The JavaScript code to execute. Top-level await is supported. Write results to a new table via db.execute(); use console.log() only for brief status messages.'
      },
      reason: {
        type: 'string',
        description: 'A plain-language explanation of why this task cannot be solved with SQL or DDL/DML, and what the script does.'
      }
    },
    required: ['code', 'reason']
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
