export interface TableColumn {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  primaryKey: boolean
}

export interface TableIndex {
  name: string
  unique: boolean
  columns: string[]
}

export interface TableInfo {
  name: string
  type: 'table' | 'view'
  rowCount: number
  columns: TableColumn[]
  indexes: TableIndex[]
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  durationMs: number
  error?: string
}

/** A column sort criterion used for server-side sorting in multi-page grids. */
export interface SortCriterion {
  colIdx: number
  dir: 'asc' | 'desc'
}

/**
 * A single page of query results used for server-side pagination.
 * `rows` contains only the current page; `totalCount` is the full result-set size.
 * When `sql` is non-empty the caller can request additional pages via db:query-page.
 */
export interface PagedQueryResult {
  columns: string[]
  rows: unknown[][]
  durationMs: number
  error?: string
  totalCount: number
  offset: number
  pageSize: number
  sql: string
}

export interface CsvPreview {
  filePath: string
  headers: string[]
  rows: string[][]
  totalLines: number
}

export interface OrgInfo {
  instanceUrl: string
  username: string
  orgId: string
}

export interface CliOrg {
  username: string
  alias?: string
  orgId?: string
  instanceUrl?: string
  isDefaultOrg?: boolean
  isScratch?: boolean
  connectedStatus?: string
}

export interface CliDiagnosticStep {
  label: string
  /** true = step succeeded or is informational; false = step failed */
  ok: boolean
  detail: string
}

export interface CliOrgsResult {
  orgs: CliOrg[]
  diagnostics: CliDiagnosticStep[]
}

export interface SObjectSummary {
  name: string
  label: string
  labelPlural: string
  queryable: boolean
  updateable: boolean
  createable: boolean
  deletable: boolean
}

export interface FieldDescriptor {
  name: string
  label: string
  type: string
  length?: number
  precision?: number
  scale?: number
  nillable: boolean
  createable: boolean
  updateable: boolean
  externalId: boolean
  unique: boolean
  idLookup: boolean
  /** Populated for reference (lookup/master-detail) fields: the target object API names. */
  referenceTo?: string[]
  /** Relationship name used for the nested Ext-ID syntax (the `__r` form). */
  relationshipName?: string | null
}

export interface ExtractJob {
  id: number
  name: string
  sfObject: string
  fields: string[]
  customExpressions: string[]
  whereClause: string | null
  rowLimit: number | null
  destTable: string
  writeMode: 'replace' | 'append'
  soqlQuery: string | null  // when set the job runs this raw SOQL; structured fields are ignored
  additionalIndexes: string[]  // extra columns to index after the job runs
  createdAt: string
  updatedAt: string
}

export type ExtractJobInput = Omit<ExtractJob, 'id' | 'createdAt' | 'updatedAt'>

export interface RunHistoryEntry {
  id: number
  jobId: number
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'success' | 'error' | 'cancelled'
  rowsLoaded: number | null
  durationMs: number | null
  errorMsg: string | null
}

export interface FieldMapping {
  sqlCol: string
  sfField: string
  excluded: boolean
  /** When true, use the nested relationship-by-external-ID syntax instead of a direct SF record ID. */
  useExternalId?: boolean
  /** The `__r` relationship name (e.g. "Account"). Required when useExternalId is true. */
  relationshipName?: string
  /** The external-ID field on the related object (e.g. "AccountNumber"). Required when useExternalId is true. */
  externalIdFieldName?: string
}

export interface WritebackJob {
  id: number
  name: string
  sqlQuery: string
  sfObject: string
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'undelete'
  fieldMap: FieldMapping[]
  externalIdField: string | null
  batchSize: number | null
  threads: number | null
  distributionKey: string[] | null
  useBulkApi: boolean
  customHeaders: string | null
  createdAt: string
  updatedAt: string
}

export type WritebackJobInput = Omit<WritebackJob, 'id' | 'createdAt' | 'updatedAt'>

export interface WritebackRunEntry {
  id: number
  jobId: number
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'success' | 'partial' | 'error' | 'cancelled'
  rowsSent: number | null
  rowsSucceeded: number | null
  rowsFailed: number | null
  durationMs: number | null
  errorMsg: string | null
  useBulkApi: boolean
}

export interface SavedQuery {
  id: number
  name: string
  sqlText: string
  tabOrder: number
  viewState: string | null
  createdAt: string
  updatedAt: string
}

/** Auto-saved snapshot of an open query tab (separate from the manually saved version). */
export interface QueryDraft {
  tabKey: string
  savedId: number | null
  name: string
  sqlText: string
  tabOrder: number
  viewState: string | null
  updatedAt: string
}

export type SavedQueryInput = Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'>

export interface JobProgress {
  runId: string
  type: 'extract' | 'writeback'
  fetched?: number
  total?: number
  succeeded?: number
  failed?: number
  rps?: number
  inFlight?: number
  rowStatuses?: Array<{ index: number; status: 'success' | 'error' | 'processing'; message?: string; id?: string }>
  /** Updated distinct error prefix list, emitted only when the set of prefixes changes. */
  distinctErrors?: Array<{ message: string; count: number }>
  // Bulk API 2.0 phases
  phase?: 'uploading' | 'processing' | 'downloading'
  bulkUploaded?: number
  jobState?: string
}

export interface JobResult {
  runId: string
  type: 'extract' | 'writeback'
  status: 'success' | 'partial' | 'error' | 'cancelled'
  rowsLoaded?: number
  rowsSucceeded?: number
  rowsFailed?: number
  errorMsg?: string
  // Bulk API 2.0: SF field column names used in failed results
  columns?: string[]
}

export interface RecentDatabase {
  path: string
  name: string
  openedAt: string
}

export type ScriptLanguage = 'javascript'

export interface SavedScript {
  id: number
  name: string
  language: ScriptLanguage
  code: string
  createdAt: string
  updatedAt: string
}

export type SavedScriptInput = Omit<SavedScript, 'id' | 'createdAt' | 'updatedAt'>

export interface ScriptDraft {
  draftKey: string         // 'new' for unsaved slot, String(savedId) for saved scripts
  savedId: number | null
  name: string
  code: string
  viewState: string | null
  updatedAt: string
}

export interface ScriptLog {
  level: 'log' | 'warn' | 'error'
  args: string[]
  ts: number
}

export interface ScriptProgress {
  runId: string
  value: number        // 0–100 (percentage, or raw value when total is provided)
  total?: number       // if provided, value is a raw count and % = value/total*100
  label?: string       // optional text shown beside the bar
}

export interface ScriptRunResult {
  runId: string
  durationMs: number
  error?: string
}

export interface ScriptComplete {
  runId: string
  durationMs: number
  error?: string
}

export interface DatabaseWasteInfo {
  pageCount: number
  freelistCount: number
  pageSize: number
  wastedBytes: number
  wastedPct: number
}
