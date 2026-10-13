export interface Settings {
  // Public HTTPS address of Kipster's client metadata document (CIMD). Unset by default.
  clientMetadataUrl?: string
}
export function clientMetadataUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Client metadata document URL is invalid')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname === '/'
  )
    throw new Error(
      'Client metadata document URL must be HTTPS with a path and no credentials or fragment',
    )
  return url.href
}
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const value = env.KIPSTER_PLUGINS_CLIENT_METADATA_URL
  return value ? { clientMetadataUrl: clientMetadataUrl(value) } : {}
}
export const callbackPath = '/callback'
// The person's browser visits this address, so it never needs to be public.
export function returnAddress(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('Return address port is invalid')
  return `http://127.0.0.1:${port}${callbackPath}`
}
// What Kipster publishes at clientMetadataUrl. Loopback redirect URIs match any
// port (RFC 8252 section 7.3).
export function clientMetadataDocument(url: string) {
  return {
    client_id: clientMetadataUrl(url),
    client_name: 'Kipster Plugins',
    client_uri: 'https://github.com/manikanta-kops/kipster-plugins',
    redirect_uris: [`http://127.0.0.1${callbackPath}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  }
}
