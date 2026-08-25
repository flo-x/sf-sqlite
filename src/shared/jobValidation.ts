/**
 * Validation rules shared between the main process's job-save path (explicit Save),
 * its execution path (Execute / list run button / Scripts), and the draft-autosave
 * path. Keeping these pure and dependency-free lets every caller (interactive or
 * headless) reach the exact same verdict for the exact same job data.
 */
import type { ExtractJob, ExtractJobInput, WritebackJob, WritebackJobInput } from './types'

/** Returns an error message if `input` is invalid, or null if it's fine to save/run. */
export function validateExtractJobInput(
  input: ExtractJobInput,
  existingId: number | null,
  siblingJobs: ExtractJob[]
): string | null {
  const isSoql = !!input.soqlQuery
  const candidateName = input.name.trim()
  const candidatePrefix = isSoql ? 'soql' : input.sfObject.toLowerCase()
  const duplicate = siblingJobs.find((j) => {
    if (j.id === existingId) return false
    const jPrefix = j.soqlQuery ? 'soql' : j.sfObject.toLowerCase()
    return jPrefix === candidatePrefix && j.name.toLowerCase() === candidateName.toLowerCase()
  })
  if (duplicate) {
    return candidateName
      ? `A job named "${candidateName}" already exists for ${candidatePrefix === 'soql' ? 'SOQL' : candidatePrefix}.`
      : `An unnamed job already exists for ${candidatePrefix === 'soql' ? 'SOQL' : candidatePrefix}.`
  }
  if (isSoql && !input.soqlQuery!.trim()) {
    return 'Please enter a SOQL query.'
  }
  return null
}

/** Returns an error message if `input` is invalid, or null if it's fine to save/run. */
export function validateWritebackJobInput(
  input: WritebackJobInput,
  existingId: number | null,
  siblingJobs: WritebackJob[]
): string | null {
  if (input.operation === 'delete') {
    const badMappings = input.fieldMap.filter((m) => !m.excluded && m.sfField && m.sfField !== 'Id')
    if (badMappings.length > 0) {
      return `Delete operations only send the Id field. Please uncheck: ${badMappings.map((m) => m.sfField).join(', ')}.`
    }
  }
  const candidateName = input.name.trim()
  const candidateObj = input.sfObject.toLowerCase()
  const duplicate = siblingJobs.find((j) => {
    if (j.id === existingId) return false
    return j.sfObject.toLowerCase() === candidateObj && j.name.toLowerCase() === candidateName.toLowerCase()
  })
  if (duplicate) {
    return candidateName
      ? `A job named "${candidateName}" already exists for ${input.sfObject}.`
      : `An unnamed job already exists for ${input.sfObject}.`
  }
  return null
}
