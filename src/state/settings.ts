export interface Settings {
  // Public HTTPS address of the client metadata document (CIMD); unset turns CIMD off.
  clientMetadataUrl?: string
}
// Kipster's published document; `serve --client-metadata-url` replaces it.
export const defaultClientMetadataUrl =
  'https://kipster.app/oauth/client-metadata.json'
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
export const callbackPath = '/callback'
// The person's browser visits this address, so it never needs to be public.
export function returnAddress(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('Return address port is invalid')
  return `http://127.0.0.1:${port}${callbackPath}`
}
// What Kipster publishes at clientMetadataUrl: this server's callback and
// Kipster Core's, on loopback only. Services match loopback return addresses on
// any port (RFC 8252 section 7.3); 43120 is Core's default for those that do not.
export function clientMetadataDocument(url: string) {
  return {
    client_id: clientMetadataUrl(url),
    client_name: 'Kipster',
    client_uri: 'https://kipster.app',
    logo_uri: 'https://kipster.app/oauth/logo.png',
    redirect_uris: [
      'http://127.0.0.1/plugins/callback',
      'http://localhost/plugins/callback',
      'http://127.0.0.1:43120/plugins/callback',
      'http://localhost:43120/plugins/callback',
      `http://127.0.0.1${callbackPath}`,
      `http://localhost${callbackPath}`,
    ],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  }
}
