import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { JobProgress, JobResult } from '../../../shared/types'

export interface ActiveJob {
  runId: string
  type: 'extract' | 'writeback'
  jobId: number
  fetched: number
  total: number | null
  succeeded: number
  failed: number
  rps: number
  status: 'running' | 'success' | 'partial' | 'error' | 'cancelled'
  errorMsg?: string
  rowStatuses: Map<number, { status: 'success' | 'error' | 'processing'; message?: string }>
}

export const useJobStore = defineStore('job', () => {
  const activeJobs = ref<Map<string, ActiveJob>>(new Map())

  function startJob(runId: string, type: 'extract' | 'writeback', jobId: number): void {
    activeJobs.value.set(runId, {
      runId,
      type,
      jobId,
      fetched: 0,
      total: null,
      succeeded: 0,
      failed: 0,
      rps: 0,
      status: 'running',
      rowStatuses: new Map()
    })
  }

  function updateProgress(progress: JobProgress): void {
    const job = activeJobs.value.get(progress.runId)
    if (!job) return
    if (progress.fetched !== undefined) job.fetched = progress.fetched
    if (progress.total !== undefined) job.total = progress.total
    if (progress.succeeded !== undefined) job.succeeded = progress.succeeded
    if (progress.failed !== undefined) job.failed = progress.failed
    if (progress.rps !== undefined) job.rps = progress.rps
    if (progress.rowStatuses) {
      for (const rs of progress.rowStatuses) {
        job.rowStatuses.set(rs.index, { status: rs.status, message: rs.message })
      }
    }
  }

  function completeJob(result: JobResult): void {
    const job = activeJobs.value.get(result.runId)
    if (!job) return
    job.status = result.status
    job.errorMsg = result.errorMsg
    if (result.rowsLoaded !== undefined) job.fetched = result.rowsLoaded
    if (result.rowsSucceeded !== undefined) job.succeeded = result.rowsSucceeded
    if (result.rowsFailed !== undefined) job.failed = result.rowsFailed
  }

  function removeJob(runId: string): void {
    activeJobs.value.delete(runId)
  }

  function getJob(runId: string): ActiveJob | undefined {
    return activeJobs.value.get(runId)
  }

  // Tracks whether any JS script is currently executing (set by ScriptsView).
  const scriptRunning = ref(false)
  function setScriptRunning(val: boolean): void {
    scriptRunning.value = val
  }

  return { activeJobs, startJob, updateProgress, completeJob, removeJob, getJob, scriptRunning, setScriptRunning }
})
