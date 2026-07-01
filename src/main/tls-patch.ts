import tls from 'tls'
import { readFileSync } from 'fs'

// Capture the original function once at module load so that repeated calls to
// applyExtraCaCert always replace the patch against the real original, not
// against a previously-patched version.
const _origCreateSecureContext = tls.createSecureContext.bind(tls)

let _shellCaCertPath: string | null = null
let _activeCertPath: string | null = null
let _disabled = false

export function setShellCaCertPath(path: string): void {
  _shellCaCertPath = path
}

export function getShellCaCertPath(): string | null {
  return _shellCaCertPath
}

/** The cert path currently patched into every TLS context, or null. */
export function getActiveCaCertPath(): string | null {
  return _activeCertPath
}

/** Remove the CA cert patch and restore the original tls.createSecureContext. */
export function clearExtraCaCert(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(tls as any).createSecureContext = _origCreateSecureContext
  _activeCertPath = null
}

/** Permanently disable the patch (even if a shell cert is present). */
export function disablePatch(): void {
  _disabled = true
  clearExtraCaCert()
}

/** Re-enable patching (call applyExtraCaCert afterwards to actually apply). */
export function enablePatch(): void {
  _disabled = false
}

export function isPatchDisabled(): boolean {
  return _disabled
}

/**
 * Monkey-patch tls.createSecureContext so that every outgoing TLS connection
 * made by Node's https module — including all LLM SDK calls — trusts the CA
 * certificate stored at certPath.
 *
 * Safe to call multiple times: each call replaces the previous patch rather
 * than stacking patches.  No-ops while the patch is disabled.
 */
export function applyExtraCaCert(certPath: string): void {
  if (_disabled) {
    return
  }

  let cert: string
  try {
    cert = readFileSync(certPath, 'utf8')
  } catch (err) {
    console.warn('[tls-patch] Failed to read CA cert file:', (err as Error).message)
    return
  }

  _activeCertPath = certPath

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(tls as any).createSecureContext = (options: tls.SecureContextOptions = {}): tls.SecureContext => {
    // When options.ca is absent, Node uses its built-in root bundle by default.
    // Specifying *any* ca value replaces that bundle entirely, so we must
    // explicitly include tls.rootCertificates to preserve trust in standard CAs
    // (e.g. DigiCert for Salesforce, Let's Encrypt, etc.) alongside our extra cert.
    const base = options.ca
      ? (Array.isArray(options.ca) ? options.ca : [options.ca])
      : tls.rootCertificates
    return _origCreateSecureContext({ ...options, ca: [...base, cert] })
  }
}
