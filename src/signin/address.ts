// Matches hasAddressTemplate in the catalogue validator; never the port.
const placeholder = /your-[^./:]+|\{[^}]+\}|<[^>]+>/i
// Substitutes the person's address into a needsAddress URL template. The
// address is either the placeholder value (`acme` for `https://{domain}.aha.io/mcp`,
// `ha.example.com:8123` for `https://YOUR-HOST/api/mcp`) or an HTTPS URL whose
// host is used. The result must be HTTPS without credentials.
export function applyAddress(template: string, address: string): string {
  const prefix = 'https://'
  const host = template.slice(prefix.length).split('/')[0] ?? ''
  const match = placeholder.exec(host)
  if (!template.startsWith(prefix) || !match)
    throw new Error('Plugin URL has no address template')
  const path = template.slice(prefix.length + host.length)
  const value = address.trim()
  let given: string
  if (value.includes('://')) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('Address is not a valid URL')
    }
    if (url.protocol !== 'https:') throw new Error('Address must use HTTPS')
    if (url.username || url.password)
      throw new Error('Address must not contain credentials')
    if (
      (url.pathname !== '/' &&
        url.pathname !== new URL(prefix + 'x' + path).pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('Give the address without a path, query or fragment')
    given = url.host
  } else given = value
  const before = host.slice(0, match.index)
  const after = host.slice(match.index + match[0].length)
  const port = /^:\d+$/.test(after)
  const fullHost = !before && (!after || port)
  // A full host for a subdomain template (acme.aha.io for {domain}.aha.io).
  if (
    (before || after) &&
    given.toLowerCase().startsWith(before.toLowerCase()) &&
    given.toLowerCase().endsWith(after.toLowerCase()) &&
    given.length > before.length + after.length
  )
    given = given.slice(before.length, given.length - after.length)
  const part = !fullHost
    ? /^[a-z0-9-]+$/i
    : port
      ? /^[a-z0-9.-]+$/i
      : /^[a-z0-9.-]+(:\d+)?$/i
  if (!part.test(given) || given.startsWith('.') || given.startsWith('-'))
    throw new Error('Address is not a valid host name')
  let result: URL
  try {
    result = new URL(prefix + before + given + after + path)
  } catch {
    throw new Error('Address is not a valid host name')
  }
  if (result.protocol !== 'https:' || result.username || result.password)
    throw new Error('Address must be HTTPS without credentials')
  return result.href
}
