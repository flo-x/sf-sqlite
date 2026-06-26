import jsforce from 'jsforce'
import type { Connection as SfConnection, Record as SfRecord, Field as SfField, SaveResult as SfSaveResult } from 'jsforce'
import { createServer } from 'http'
import { request as httpsRequest } from 'https'
import { createGunzip } from 'zlib'
import { randomBytes } from 'crypto'
import { shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, access } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { OrgInfo, CliOrg, SObjectSummary, FieldDescriptor, PasswordCreds, QueryResult } from '../shared/types'

const execFileAsync = promisify(execFile)

// Additional absolute paths to try if 'sf' / 'sfdx' are not on PATH.
// These cover the SF CLI self-installer and common package managers.
const SF_EXTRA_PATHS: string[] = [
  join(homedir(), '.local', 'share', 'sf', 'bin', 'sf'),
  '/opt/homebrew/bin/sf',
  '/usr/local/bin/sf',
]
const SFDX_EXTRA_PATHS: string[] = [
  '/opt/homebrew/bin/sfdx',
  '/usr/local/bin/sfdx',
]

/** Returns every candidate command to try for a given base name, PATH-based first. */
function sfCandidates(base: 'sf' | 'sfdx'): string[] {
  const extras = base === 'sf' ? SF_EXTRA_PATHS : SFDX_EXTRA_PATHS
  return [base, ...extras]
}

async function execSfCommand(
  base: 'sf' | 'sfdx',
  args: string[],
  opts: { timeout: number }
): Promise<string> {
  for (const cmd of sfCandidates(base)) {
    try {
      // Quick existence check for absolute paths (skip for bare names)
      if (cmd.startsWith('/') || cmd.includes('/')) {
        await access(cmd)
      }
      const { stdout } = await execFileAsync(cmd, args, opts)
      return stdout
    } catch {
      // try next candidate
    }
  }
  throw new Error(`${base} CLI not found`)
}


let connection: SfConnection | null = null
let currentOrgInfo: OrgInfo | null = null

export function getConnection(): SfConnection {
  if (!connection) throw new Error('Not connected to Salesforce')
  return connection
}

export function isConnected(): boolean {
  return connection !== null
}

export function getOrgInfo(): OrgInfo | null {
  return currentOrgInfo
}

/**
 * Queries /services/data/ on the connected org and pins the connection to the
 * highest API version the org supports. This avoids UNSUPPORTED_API_VERSION
 * errors when jsforce's built-in default is newer than what the org exposes.
 */
async function detectAndSetApiVersion(conn: SfConnection): Promise<void> {
  try {
    type VersionEntry = { version: string; label: string; url: string }
    const versions = await conn.request<VersionEntry[]>('/services/data/')
    if (Array.isArray(versions) && versions.length > 0) {
      const latest = versions
        .map((v) => parseFloat(v.version))
        .filter((n) => !isNaN(n))
        .sort((a, b) => b - a)[0]
      if (latest) {
        conn.version = latest.toFixed(1)
      }
    }
  } catch {
    // If the probe fails just leave the default version in place
  }
}

export async function connectPassword(creds: PasswordCreds): Promise<OrgInfo> {
  // compress: true is valid at runtime but absent from @types/jsforce typings
  const conn = new jsforce.Connection({
    loginUrl: creds.instanceUrl || 'https://login.salesforce.com',
    compress: true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  await conn.login(creds.username, creds.password + creds.token)
  await detectAndSetApiVersion(conn)
  connection = conn
  const identity = await conn.identity()
  currentOrgInfo = {
    instanceUrl: conn.instanceUrl,
    username: identity.username,
    orgId: identity.organization_id
  }
  return currentOrgInfo
}

export async function connectOAuth(clientId: string): Promise<OrgInfo> {
  return new Promise((resolve, reject) => {
    const port = 8788 + Math.floor(Math.random() * 200)
    const redirectUri = `http://localhost:${port}/callback`

    // Random state nonce — prevents CSRF / authorization-code injection attacks.
    // The callback server rejects any request whose state parameter doesn't match.
    const expectedState = randomBytes(24).toString('hex')

    const oauth2 = new jsforce.OAuth2({
      loginUrl: 'https://login.salesforce.com',
      clientId,
      redirectUri
    })

    const server = createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404)
        res.end()
        return
      }
      const url = new URL(req.url, `http://localhost:${port}`)
      const returnedState = url.searchParams.get('state')
      if (returnedState !== expectedState) {
        res.writeHead(400)
        res.end('Invalid state')
        reject(new Error('OAuth callback state mismatch — possible CSRF attack'))
        server.close()
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400)
        res.end('Missing code')
        reject(new Error('OAuth callback missing code'))
        server.close()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Authenticated! You can close this tab.</h2></body></html>')
      server.close()

      // compress: true is valid at runtime but absent from @types/jsforce typings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conn = new jsforce.Connection({ oauth2, compress: true } as any)
      conn
        .authorize(code)
        .then(() => detectAndSetApiVersion(conn))
        .then(() => conn.identity())
        .then((identity) => {
          connection = conn
          currentOrgInfo = {
            instanceUrl: conn.instanceUrl,
            username: identity.username,
            orgId: identity.organization_id
          }
          resolve(currentOrgInfo)
        })
        .catch(reject)
    })

    server.listen(port, () => {
      const authUrl = oauth2.getAuthorizationUrl({ scope: 'api refresh_token', state: expectedState })
      shell.openExternal(authUrl)
    })

    server.on('error', reject)
    setTimeout(() => {
      server.close()
      reject(new Error('OAuth timeout'))
    }, 120_000)
  })
}

export function disconnectSalesforce(): void {
  connection = null
  currentOrgInfo = null
}

export async function listCliOrgs(): Promise<CliOrg[]> {
  // Try 'sf' (v2+) then 'sfdx' (v1), each with multiple PATH/absolute candidates
  for (const [base, args] of [
    ['sf',   ['org', 'list', '--json']],
    ['sfdx', ['force:org:list', '--json']]
  ] as ['sf' | 'sfdx', string[]][]) {
    try {
      const stdout = await execSfCommand(base, args, { timeout: 10_000 })
      const parsed = JSON.parse(stdout)
      const result = parsed?.result ?? {}
      const nonScratch: CliOrg[] = (result.nonScratchOrgs ?? []).map((o: Record<string, unknown>) => ({
        username: o.username as string,
        alias: o.alias as string | undefined,
        orgId: o.orgId as string | undefined,
        instanceUrl: o.instanceUrl as string | undefined,
        isDefaultOrg: o.isDefaultOrg as boolean | undefined,
        isScratch: false,
        connectedStatus: o.connectedStatus as string | undefined
      }))
      const scratch: CliOrg[] = (result.scratchOrgs ?? []).map((o: Record<string, unknown>) => ({
        username: o.username as string,
        alias: o.alias as string | undefined,
        orgId: o.orgId as string | undefined,
        instanceUrl: o.instanceUrl as string | undefined,
        isDefaultOrg: o.isDefaultOrg as boolean | undefined,
        isScratch: true,
        connectedStatus: o.connectedStatus as string | undefined
      }))
      return [...nonScratch, ...scratch]
    } catch {
      // try next CLI variant
    }
  }
  return []
}

export async function connectCliOrg(username: string): Promise<OrgInfo> {
  // 'sf org display' fetches current auth info and refreshes the token if needed
  let accessToken: string | undefined
  let instanceUrl: string | undefined

  for (const [base, args] of [
    ['sf',   ['org', 'display', '--target-org', username, '--json']],
    ['sfdx', ['force:org:display', '--targetusername', username, '--json']]
  ] as ['sf' | 'sfdx', string[]][]) {
    try {
      const stdout = await execSfCommand(base, args, { timeout: 15_000 })
      const parsed = JSON.parse(stdout)
      accessToken = parsed?.result?.accessToken
      instanceUrl = parsed?.result?.instanceUrl
      if (accessToken && instanceUrl) break
    } catch {
      // try next CLI variant or fall through to credential file
    }
  }

  // Fallback: read credential files directly
  if (!accessToken || !instanceUrl) {
    const sfCredPath = join(homedir(), '.sf', 'credentials.json')
    const sfdxCredPath = join(homedir(), '.sfdx', `${username}.json`)

    try {
      const raw = JSON.parse(await readFile(sfCredPath, 'utf8'))
      const cred = raw[username]
      if (cred?.accessToken) { accessToken = cred.accessToken; instanceUrl = cred.instanceUrl }
    } catch { /* try sfdx path */ }

    if (!accessToken) {
      try {
        const cred = JSON.parse(await readFile(sfdxCredPath, 'utf8'))
        if (cred?.accessToken) { accessToken = cred.accessToken; instanceUrl = cred.instanceUrl }
      } catch { /* ignore */ }
    }
  }

  if (!accessToken || !instanceUrl) {
    throw new Error(
      `Could not retrieve credentials for ${username}.\nRun: sf org login web --target-org ${username}`
    )
  }

  // compress: true is valid at runtime but absent from @types/jsforce typings
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = new jsforce.Connection({ instanceUrl, accessToken, compress: true } as any)
  await detectAndSetApiVersion(conn)
  const identity = await conn.identity()
  connection = conn
  currentOrgInfo = {
    instanceUrl: conn.instanceUrl,
    username: identity.username,
    orgId: identity.organization_id
  }
  return currentOrgInfo
}

export async function listObjects(): Promise<SObjectSummary[]> {
  const conn = getConnection()
  const result = await conn.describeGlobal()
  return result.sobjects
    .filter((o) => o.queryable)
    .map(
      (o): SObjectSummary => ({
        name: o.name,
        label: o.label,
        labelPlural: o.labelPlural,
        queryable: o.queryable,
        updateable: o.updateable,
        createable: o.createable,
        deletable: o.deletable
      })
    )
}

export async function describeObject(name: string): Promise<FieldDescriptor[]> {
  const conn = getConnection()
  const meta = await conn.describe(name)
  return meta.fields.map(
    (f: SfField): FieldDescriptor => ({
      name: f.name,
      label: f.label,
      type: f.type,
      length: f.length,
      precision: f.precision,
      scale: f.scale,
      nillable: f.nillable,
      createable: f.createable,
      updateable: f.updateable,
      externalId: f.externalId,
      unique: f.unique,
      idLookup: f.idLookup
    })
  )
}

export interface ExtractOptions {
  sfObject: string
  fields: string[]
  whereClause?: string | null
  rowLimit?: number | null
}

export type ProgressCallback = (fetched: number, total: number | null) => void

export async function extractRecords(
  opts: ExtractOptions,
  onProgress: ProgressCallback,
  onBatch: (records: Record<string, unknown>[]) => void,
  signal: AbortSignal
): Promise<number> {
  const conn = getConnection()
  const fieldList = opts.fields.join(', ')
  let soql = `SELECT ${fieldList} FROM ${opts.sfObject}`
  if (opts.whereClause?.trim()) soql += ` WHERE ${opts.whereClause}`
  if (opts.rowLimit) soql += ` LIMIT ${opts.rowLimit}`

  let fetched = 0
  let total: number | null = null

  const result = await conn.query(soql)
  total = result.totalSize
  onProgress(0, total)

  // Fields containing dots are relationship traversals (e.g. CreatedBy.Name).
  // Salesforce returns them as nested objects; we flatten them to underscore keys.
  const dotFields = opts.fields.filter((f) => f.includes('.'))

  function isSfRelObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && 'attributes' in v
  }

  function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
    let cur: unknown = obj
    for (const seg of path) {
      if (cur == null || typeof cur !== 'object') return null
      cur = (cur as Record<string, unknown>)[seg]
    }
    return cur
  }

  const processRecords = (records: SfRecord[]): void => {
    if (signal.aborted) return
    const clean = records.map((r) => {
      const { attributes: _a, ...rest } = r as Record<string, unknown> & { attributes: unknown }
      const flat: Record<string, unknown> = {}

      // Copy scalar / non-relationship values directly
      for (const [k, v] of Object.entries(rest)) {
        if (!isSfRelObject(v)) {
          flat[k] = v
        }
      }

      // Flatten each dot-notation field into an underscore-keyed column
      for (const field of dotFields) {
        const segments = field.split('.')
        flat[segments.join('_')] = getNestedValue(rest, segments)
      }

      return flat
    })
    onBatch(clean)
    fetched += clean.length
    onProgress(fetched, total)
  }

  processRecords(result.records)

  let next = result
  while (!next.done && !signal.aborted) {
    next = await conn.queryMore(next.nextRecordsUrl!)
    processRecords(next.records)
  }

  return fetched
}

/**
 * Execute a raw SOQL string and stream the results, flattening nested SF objects
 * generically into underscore-delimited column names.
 */
export async function extractSoql(
  soql: string,
  onProgress: ProgressCallback,
  onBatch: (records: Record<string, unknown>[]) => void,
  signal: AbortSignal
): Promise<number> {
  const conn = getConnection()
  let fetched = 0
  let total: number | null = null

  function flattenRecord(r: SfRecord): Record<string, unknown> {
    const flat: Record<string, unknown> = {}

    function extract(obj: Record<string, unknown>, prefix: string): void {
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'attributes') continue
        const key = prefix ? `${prefix}_${k}` : k
        if (v !== null && typeof v === 'object') {
          const vo = v as Record<string, unknown>
          if ('attributes' in vo) {
            // Nested SF sObject — recurse, building underscore-prefixed keys
            extract(vo, key)
          } else if ('records' in vo) {
            // Nested subquery result set — skip
          } else {
            // Unknown object (e.g. address compound field) — stringify
            flat[key] = JSON.stringify(v)
          }
        } else {
          flat[key] = v
        }
      }
    }

    const { attributes: _a, ...rest } = r as Record<string, unknown> & { attributes: unknown }
    extract(rest, '')
    return flat
  }

  const result = await conn.query(soql)
  total = result.totalSize
  onProgress(0, total)

  const processRecords = (records: SfRecord[]): void => {
    if (signal.aborted) return
    const clean = records.map(flattenRecord)
    onBatch(clean)
    fetched += clean.length
    onProgress(fetched, total)
  }

  processRecords(result.records)

  let next = result
  while (!next.done && !signal.aborted) {
    next = await conn.queryMore(next.nextRecordsUrl!)
    processRecords(next.records)
  }

  return fetched
}

export interface WritebackOptions {
  sfObject: string
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'undelete'
  externalIdField?: string | null
  batchSize?: number
  threads?: number
  distributionKey?: string[] | null
  customHeaders?: Record<string, string>
  useBulkApi?: boolean
}

/** FNV-1a 32-bit hash — fast, pure-JS, no dependencies. */
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export type WritebackResult = {
  index: number
  id?: string
  success: boolean
  errors: string[]
}

export async function writebackBatch(
  opts: WritebackOptions,
  records: Record<string, unknown>[],
  onBatchStart: (count: number) => void,
  onBatchResult: (results: WritebackResult[]) => void,
  signal: AbortSignal
): Promise<{ succeeded: number; failed: number }> {
  const conn = getConnection()
  const batchSize = opts.batchSize || 200
  const threads = Math.min(opts.threads || 1, 10)

  let succeeded = 0
  let failed = 0
  const batches: Record<string, unknown>[][] = []
  for (let i = 0; i < records.length; i += batchSize) {
    batches.push(records.slice(i, i + batchSize))
  }

  type RawResultArr = SfSaveResult[]
  // jsforce DML options type doesn't expose `headers` in its public typings,
  // so we cast to `any` here to pass extra headers through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dmlOpts: any = opts.customHeaders ? { headers: opts.customHeaders } : {}

  // When origIndices is provided (distribution-key path) it maps position-in-batch
  // back to position-in-records; otherwise startIndex+i is used (sequential path).
  const processBatch = async (
    batch: Record<string, unknown>[],
    startIndex: number,
    origIndices?: number[]
  ): Promise<void> => {
    if (signal.aborted) return
    onBatchStart(batch.length)
    const sobject = conn.sobject(opts.sfObject)
    let rawResults: SfSaveResult[]
    if (opts.operation === 'insert') {
      rawResults = await sobject.insert(batch as SfRecord[], dmlOpts)
    } else if (opts.operation === 'update') {
      rawResults = await sobject.update(batch as any, dmlOpts)
    } else if (opts.operation === 'upsert') {
      rawResults = await sobject.upsert(batch as SfRecord[], opts.externalIdField || 'Id', dmlOpts)
    } else if (opts.operation === 'delete') {
      const ids = batch.map((r) => r['Id'] as string).filter(Boolean)
      rawResults = await sobject.delete(ids, dmlOpts)
    } else {
      // undelete — use REST API directly
      const ids = batch.map((r) => r['Id'] as string).filter(Boolean)
      const resp = await conn.requestPost<RawResultArr>('/composite/sobjects', {
        allOrNone: false,
        records: ids.map((id) => ({ attributes: { type: opts.sfObject }, Id: id }))
      }, { headers: opts.customHeaders })
      rawResults = (Array.isArray(resp) ? resp : []) as SfSaveResult[]
    }

    type RawResult = { id?: string; success: boolean; errors?: Array<string | { message: string }> }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const results: WritebackResult[] = (Array.isArray(rawResults) ? rawResults : [rawResults]).map(
      (r, i): WritebackResult => {
        const raw = r as RawResult
        return {
          index: origIndices ? origIndices[i] : startIndex + i,
          id: raw.id,
          success: raw.success,
          errors: raw.success ? [] : (raw.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message))
        }
      }
    )

    for (const r of results) {
      if (r.success) succeeded++
      else failed++
    }
    onBatchResult(results)
  }

  if (threads <= 1) {
    // Single thread: run all batches sequentially, no probe needed.
    for (let i = 0; i < batches.length && !signal.aborted; i++) {
      await processBatch(batches[i], i * batchSize)
    }
    return { succeeded, failed }
  }

  // ── Multi-thread execution with probe phase ──────────────────────────────────
  //
  // Phase 1 (probe): run lane 0 one batch at a time, inspecting success rates.
  //   • ≥50% success in a batch   → go full parallel immediately.
  //   • 5 cumulative 0%-batches   → abort (data is completely wrong).
  //   • 10 cumulative <50%-batches → give up probing, go full parallel anyway.
  //
  // Phase 2 (full parallel): launch all lanes concurrently — lane 0 continues
  // from where the probe left off; lanes 1..N-1 start from the beginning.

  type BatchDesc = { batch: Record<string, unknown>[]; startIndex: number; origIndices?: number[] }

  let lane0: BatchDesc[]
  let otherLaneFns: Array<() => Promise<void>>

  if (opts.distributionKey && opts.distributionKey.length > 0) {
    // Hash-based lane assignment.
    const dk = opts.distributionKey
    const lanes: Array<Array<{ record: Record<string, unknown>; origIdx: number }>> =
      Array.from({ length: threads }, () => [])
    records.forEach((record, origIdx) => {
      const keyStr = dk.map((f) => String(record[f] ?? '')).join('\0')
      lanes[hashStr(keyStr) % threads].push({ record, origIdx })
    })
    lane0 = []
    for (let i = 0; i < lanes[0].length; i += batchSize) {
      const slice = lanes[0].slice(i, i + batchSize)
      lane0.push({ batch: slice.map((e) => e.record), startIndex: 0, origIndices: slice.map((e) => e.origIdx) })
    }
    otherLaneFns = lanes.slice(1).map((laneEntries) => async () => {
      for (let i = 0; i < laneEntries.length && !signal.aborted; i += batchSize) {
        const slice = laneEntries.slice(i, i + batchSize)
        await processBatch(slice.map((e) => e.record), 0, slice.map((e) => e.origIdx))
      }
    })
  } else {
    // Round-robin lane assignment: lane j gets batches j, j+threads, j+2*threads, …
    const lanes = Array.from({ length: threads }, (_, j) =>
      batches.filter((_, i) => i % threads === j)
    )
    lane0 = lanes[0].map((batch, p) => ({ batch, startIndex: p * threads * batchSize }))
    otherLaneFns = lanes.slice(1).map((laneBatches, j) => async () => {
      const laneIdx = j + 1
      for (let p = 0; p < laneBatches.length && !signal.aborted; p++) {
        await processBatch(laneBatches[p], (laneIdx + p * threads) * batchSize)
      }
    })
  }

  // ── Phase 1: probe ───────────────────────────────────────────────────────────
  const PROBE_ZERO_LIMIT = 5
  const PROBE_SUB50_LIMIT = 10
  let zeroCount = 0
  let subFiftyCount = 0
  let probeIdx = 0

  while (probeIdx < lane0.length && !signal.aborted) {
    const { batch, startIndex, origIndices } = lane0[probeIdx]
    const snapSucceeded = succeeded
    await processBatch(batch, startIndex, origIndices)
    const batchSucceeded = succeeded - snapSucceeded
    const batchRate = batch.length > 0 ? batchSucceeded / batch.length : 1
    probeIdx++

    if (batchRate >= 0.5) {
      break // probe passed → unleash full parallelism
    }
    if (batchSucceeded === 0) zeroCount++
    subFiftyCount++
    if (zeroCount >= PROBE_ZERO_LIMIT) {
      throw new Error(
        `Writeback aborted: ${zeroCount} consecutive probe batches had 0% success. ` +
        `All rows are failing — please check your data, field mappings, and Salesforce validation rules.`
      )
    }
    if (subFiftyCount >= PROBE_SUB50_LIMIT) {
      break // gave up probing → go full parallel anyway
    }
  }

  // ── Phase 2: full parallel ───────────────────────────────────────────────────
  if (!signal.aborted) {
    const remainingLane0 = async (): Promise<void> => {
      for (let i = probeIdx; i < lane0.length && !signal.aborted; i++) {
        await processBatch(lane0[i].batch, lane0[i].startIndex, lane0[i].origIndices)
      }
    }
    await Promise.all([remainingLane0(), ...otherLaneFns.map((fn) => fn())])
  }

  return { succeeded, failed }
}

// ─── Bulk API 2.0 ─────────────────────────────────────────────────────────────

export interface Bulk2Progress {
  phase: 'uploading' | 'processing' | 'downloading'
  uploaded?: number
  processed?: number
  failed?: number
  jobState?: string
}

export interface Bulk2Result {
  succeeded: number
  failed: number
  /** SF field names present in the uploaded records (no sf__ meta columns). */
  sfColumns: string[]
  failedEntries: Array<{ index: number; message: string; row: unknown[] }>
  insertedIds: Array<{ index: number; id: string }>
}

/** Low-level HTTPS helper — jsforce v1 has no native Bulk API 2.0 support. */
async function sfRawRequest(
  accessToken: string,
  instanceUrl: string,
  method: string,
  urlPath: string,
  body?: string,
  contentType = 'application/json',
  accept = 'application/json'
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, instanceUrl)
    const bodyBuf = body != null ? Buffer.from(body, 'utf8') : undefined
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 443,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': contentType,
          Accept: accept,
          'Accept-Encoding': 'gzip',
          ...(bodyBuf ? { 'Content-Length': bodyBuf.byteLength } : {})
        }
      },
      (res) => {
        // Capture response headers before we potentially pipe through gunzip.
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (v) { headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v) }
        }
        const status = res.statusCode ?? 0

        // Decompress on the fly if the server chose gzip; otherwise read raw.
        const stream = headers['content-encoding'] === 'gzip'
          ? res.pipe(createGunzip())
          : res

        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        stream.on('end', () => {
          resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8') })
        })
        stream.on('error', reject)
      }
    )
    req.on('error', reject)
    if (bodyBuf) { req.write(bodyBuf) }
    req.end()
  })
}

/**
 * HTTP PUT with chunked transfer encoding — no Content-Length header is sent,
 * which causes Node.js to use Transfer-Encoding: chunked automatically.
 * The caller receives a `write` function and calls it repeatedly to stream
 * data, then resolves the returned promise when done.
 * This satisfies Salesforce's "single PUT per job" requirement while keeping
 * memory usage proportional to one chunk at a time.
 */
function sfStreamingPut(
  accessToken: string,
  instanceUrl: string,
  urlPath: string,
  contentType: string,
  streamer: (write: (chunk: string) => void) => Promise<void>
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, instanceUrl)
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 443,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': contentType,
          Accept: 'application/json'
          // Intentionally no Content-Length → Node uses Transfer-Encoding: chunked
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        res.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (v) { headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v) }
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') })
        })
      }
    )
    req.on('error', reject)

    streamer((chunk) => req.write(chunk))
      .then(() => req.end())
      .catch((err) => {
        req.destroy(err instanceof Error ? err : new Error(String(err)))
        reject(err)
      })
  })
}

function recordsToCSV(columns: string[], records: Record<string, unknown>[]): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s
  }
  const lines = [columns.join(',')]
  for (const rec of records) {
    lines.push(columns.map((c) => escape(rec[c])).join(','))
  }
  return lines.join('\n')
}

function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[][] = []
  let col = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { col += '"'; i++ }
        else { inQuotes = false }
      } else {
        col += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        row.push(col); col = ''
      } else if (ch === '\n') {
        row.push(col); col = ''
        if (row.length > 1 || row[0].length > 0) { lines.push(row) }
        row = []
      } else if (ch !== '\r') {
        col += ch
      }
    }
  }
  row.push(col)
  if (row.length > 1 || row[0].length > 0) { lines.push(row) }
  if (lines.length === 0) return { headers: [], rows: [] }
  return { headers: lines[0], rows: lines.slice(1) }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Write records to Salesforce using the asynchronous Bulk API 2.0.
 * `recordChunks` is an async iterable that yields successive batches of
 * already-mapped SF records (keys = SF field names).
 */
export async function writebackBulk2(
  opts: WritebackOptions,
  recordChunks: AsyncIterable<Record<string, unknown>[]>,
  onProgress: (p: Bulk2Progress) => void,
  signal: AbortSignal
): Promise<Bulk2Result> {
  if (opts.operation === 'undelete') {
    throw new Error(
      "Salesforce Bulk API 2.0 does not support 'undelete'. " +
      "Disable 'Use Bulk API 2.0' for this operation."
    )
  }

  const conn = getConnection()
  const jobsBase = `/services/data/v${conn.version}/jobs/ingest`
  const accessToken = conn.accessToken as string
  const instanceUrl = conn.instanceUrl

  const req = (
    method: string,
    path: string,
    body?: string,
    ct?: string,
    accept?: string
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> =>
    sfRawRequest(accessToken, instanceUrl, method, path, body, ct, accept)

  // ── 1. Create job ─────────────────────────────────────────────────────────
  const createResp = await req(
    'POST',
    jobsBase,
    JSON.stringify({
      object: opts.sfObject,
      operation: opts.operation,
      lineEnding: 'LF',
      columnDelimiter: 'COMMA',
      contentType: 'CSV',
      ...(opts.externalIdField ? { externalIdFieldName: opts.externalIdField } : {})
    })
  )
  if (createResp.status < 200 || createResp.status >= 300) {
    throw new Error(`Failed to create Bulk 2.0 job: ${createResp.body}`)
  }
  const jobId = (JSON.parse(createResp.body) as { id: string }).id

  // Tracks whether PATCH UploadComplete was sent successfully.
  // Before that, the job is still Open and must be cleaned up with DELETE.
  // After that, it is InProgress and must be cleaned up with PATCH Aborted.
  let uploadCompleted = false

  // Set to true when the SF job reaches a terminal state (JobComplete / Failed
  // / Aborted) so the finally block knows no cleanup is required.
  let sfJobTerminated = false

  try {
    // ── 2. Upload data via a single streaming PUT ─────────────────────────
    // We use HTTP chunked transfer encoding (no Content-Length header) so we
    // can stream pages from SQLite one at a time without holding the full
    // dataset in memory. Salesforce sees a single uninterrupted PUT body.
    let sfColumns: string[] | null = null
    let totalUploaded = 0

    const csvEscape = (v: unknown): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s
    }

    const uploadResp = await sfStreamingPut(
      accessToken,
      instanceUrl,
      `${jobsBase}/${jobId}/batches`,
      'text/csv',
      async (write) => {
        for await (const chunk of recordChunks) {
          if (signal.aborted) { throw new Error('Cancelled') }
          if (chunk.length === 0) continue

          if (sfColumns === null) {
            sfColumns = Object.keys(chunk[0])
            write(sfColumns.join(',') + '\n')
          }

          for (const record of chunk) {
            write(sfColumns.map((c) => csvEscape(record[c])).join(',') + '\n')
          }

          totalUploaded += chunk.length
          onProgress({ phase: 'uploading', uploaded: totalUploaded })
        }
      }
    )

    if (uploadResp.status < 200 || uploadResp.status >= 300) {
      throw new Error(`Bulk 2.0 upload failed (HTTP ${uploadResp.status}): ${uploadResp.body}`)
    }

    if (sfColumns === null) {
      // Nothing to upload — delete the Open job we just created and return.
      sfJobTerminated = true
      void req('DELETE', `${jobsBase}/${jobId}`)
      return { succeeded: 0, failed: 0, sfColumns: [], failedEntries: [], insertedIds: [] }
    }
    // Pin to a typed const so TypeScript doesn't lose track of the narrowing
    // across the subsequent await calls.
    const uploadedColumns: string[] = sfColumns

    // ── 3. Close job (mark upload complete) ───────────────────────────────
    const closeResp = await req('PATCH', `${jobsBase}/${jobId}`, JSON.stringify({ state: 'UploadComplete' }))
    if (closeResp.status < 200 || closeResp.status >= 300) {
      throw new Error(`Failed to close Bulk 2.0 job: ${closeResp.body}`)
    }
    uploadCompleted = true

    // ── 4. Poll for completion ─────────────────────────────────────────────
    let pollDelay = 2_000
    let finalProcessed = 0
    let finalFailed = 0
    while (!signal.aborted) {
      await sleep(pollDelay)
      pollDelay = Math.min(pollDelay + 1_000, 10_000)

      const pollResp = await req('GET', `${jobsBase}/${jobId}`)
      if (pollResp.status < 200 || pollResp.status >= 300) {
        throw new Error(`Failed to poll Bulk 2.0 job: ${pollResp.body}`)
      }
      const status = JSON.parse(pollResp.body) as {
        state: string
        numberRecordsProcessed: number
        numberRecordsFailed: number
      }
      finalProcessed = status.numberRecordsProcessed
      finalFailed = status.numberRecordsFailed
      onProgress({
        phase: 'processing',
        processed: finalProcessed,
        failed: finalFailed,
        jobState: status.state
      })
      if (status.state === 'JobComplete' || status.state === 'Failed' || status.state === 'Aborted') {
        sfJobTerminated = true
        break
      }
    }
    if (signal.aborted) { throw new Error('Cancelled') }

    // ── 5. Download failed results only ───────────────────────────────────
    // Successful-results download is intentionally skipped for Bulk API 2.0:
    // the success count comes from the final poll response, and individual IDs
    // for inserts are not surfaced (they would require downloading potentially
    // millions of rows). The standard REST Collections API still returns IDs.
    onProgress({ phase: 'downloading' })

    // Data columns = uploaded columns minus any sf__ meta fields.
    const dataHeaders = uploadedColumns.filter((h: string) => !h.startsWith('sf__'))

    // Failed results
    const failedEntries: Array<{ index: number; message: string; row: unknown[] }> = []
    let failedLocator: string | null = null
    do {
      const path = failedLocator
        ? `${jobsBase}/${jobId}/failedResults?locator=${failedLocator}`
        : `${jobsBase}/${jobId}/failedResults`
      const resp = await req('GET', path, undefined, undefined, 'text/csv')
      if (resp.status < 200 || resp.status >= 300) break
      const loc = resp.headers['sforce-locator']
      failedLocator = (loc && loc !== 'null') ? loc : null
      const parsed = parseCsvText(resp.body)
      const errorIdx = parsed.headers.indexOf('sf__Error')
      const dataIdxMap = dataHeaders.map((h: string) => parsed.headers.indexOf(h))
      for (const row of parsed.rows) {
        failedEntries.push({
          index: failedEntries.length,
          message: errorIdx >= 0 ? row[errorIdx] : 'Unknown error',
          row: dataIdxMap.map((i: number) => (i >= 0 ? row[i] : null))
        })
      }
    } while (failedLocator)

    return {
      succeeded: finalProcessed - finalFailed,
      failed: failedEntries.length,
      sfColumns: dataHeaders,
      failedEntries,
      insertedIds: []
    }
  } finally {
    // Close the Salesforce job if it hasn't already reached a terminal state.
    // This covers cancellation, errors during upload/close/poll, and any other
    // unexpected exit path.
    if (!sfJobTerminated) {
      if (uploadCompleted) {
        // Job was submitted (InProgress or UploadComplete) — abort it.
        // Fall back to DELETE if PATCH is rejected for any reason.
        void req('PATCH', `${jobsBase}/${jobId}`, JSON.stringify({ state: 'Aborted' }))
          .catch(() => void req('DELETE', `${jobsBase}/${jobId}`))
      } else {
        // Job was still Open — just delete it.
        void req('DELETE', `${jobsBase}/${jobId}`)
      }
    }
  }
}

// ─── SOQL Query ───────────────────────────────────────────────────────────────

export async function runSoqlQuery(soql: string): Promise<QueryResult> {
  const conn = getConnection()

  function isSfRelObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && 'attributes' in v
  }

  function flattenRecord(r: SfRecord): Record<string, unknown> {
    const { attributes: _a, ...rest } = r as Record<string, unknown> & { attributes: unknown }
    const flat: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rest)) {
      if (isSfRelObject(v)) {
        for (const [rk, rv] of Object.entries(v)) {
          if (rk === 'attributes') continue
          flat[`${k}_${rk}`] = isSfRelObject(rv) ? JSON.stringify(rv) : rv
        }
      } else {
        flat[k] = v
      }
    }
    return flat
  }

  const SOQL_ROW_CAP = 100_000

  const allRecords: Record<string, unknown>[] = []
  const result = await conn.query(soql)
  allRecords.push(...result.records.map(flattenRecord))

  let next = result
  while (!next.done) {
    if (allRecords.length >= SOQL_ROW_CAP) {
      throw new Error(
        `SOQL query returned more than ${SOQL_ROW_CAP.toLocaleString()} rows. ` +
        `Add a LIMIT clause or narrow your WHERE condition to reduce the result set.`
      )
    }
    next = await conn.queryMore(next.nextRecordsUrl!)
    allRecords.push(...next.records.map(flattenRecord))
  }

  if (allRecords.length === 0) {
    return { columns: [], rows: [], durationMs: 0 }
  }

  const columns = Object.keys(allRecords[0])
  const rows = allRecords.map((r) => columns.map((c) => r[c] ?? null))
  return { columns, rows, durationMs: 0 }
}
