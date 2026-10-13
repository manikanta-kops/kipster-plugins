import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  followRedirects,
  RedirectError,
  type RedirectOptions,
} from '../src/net/redirects.ts'
import { guardedFetch, upstreamFetch } from '../src/signin/fetch.ts'

// A fake network: each URL answers with a redirect (status and Location) or 200.
function network(routes: Record<string, [number, string?]>) {
  const calls: {
    url: string
    method: string
    headers: Headers
    body: unknown
    signal?: AbortSignal | null
  }[] = []
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
      signal: init.signal,
    })
    assert.equal(init.redirect, 'manual')
    const [status, location] = routes[url] ?? [200]
    return new Response(status === 200 ? 'final' : 'moved', {
      status,
      headers: location ? { Location: location } : {},
    })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}
const post = (headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: '{"jsonrpc":"2.0"}',
})
async function refused(
  routes: Record<string, [number, string?]>,
  url: string,
  init: RequestInit,
  message: RegExp,
  options: RedirectOptions = {},
) {
  const net = network(routes)
  await assert.rejects(
    followRedirects(url, init, { ...options, fetch: net.fetch }),
    (error) => error instanceof RedirectError && message.test(error.message),
  )
  return net.calls
}

test('same-origin 307 and 308 re-send a POST with its method, headers and body', async () => {
  for (const status of [307, 308]) {
    const net = network({
      'https://a.example/mcp': [status, '/mcp/'],
    })
    const result = await followRedirects(
      'https://a.example/mcp',
      post({ Authorization: 'Bearer token-1' }),
      { fetch: net.fetch },
    )
    assert.equal(result.response.status, 200)
    assert.equal(result.url.href, 'https://a.example/mcp/')
    assert.equal(result.redirects, 1)
    assert.deepEqual(
      net.calls.map((c) => c.url),
      ['https://a.example/mcp', 'https://a.example/mcp/'],
    )
    const [first, second] = net.calls
    assert.equal(second!.method, 'POST')
    assert.equal(second!.body, first!.body)
    assert.equal(second!.headers.get('authorization'), 'Bearer token-1')
    assert.equal(second!.headers.get('content-type'), 'application/json')
  }
  // URLSearchParams bodies, as the SDK's token requests use, replay too.
  const net = network({ 'https://a.example/token': [307, '/oauth/token'] })
  const form = new URLSearchParams({ client_secret: 's', grant_type: 'x' })
  await followRedirects(
    'https://a.example/token',
    { method: 'POST', body: form },
    { fetch: net.fetch },
  )
  assert.equal(net.calls[1]!.body, form)
})
test('a POST or a credential-bearing request never leaves its origin', async () => {
  const cross = {
    'https://a.example/mcp': [307, 'https://b.example/mcp'],
  } as Record<string, [number, string?]>
  let calls = await refused(
    cross,
    'https://a.example/mcp',
    post(),
    /another origin \(https:\/\/b\.example\) refused/,
  )
  assert.equal(calls.length, 1)
  for (const status of [301, 302, 303, 307, 308]) {
    calls = await refused(
      { 'https://a.example/userinfo': [status, 'https://b.example/userinfo'] },
      'https://a.example/userinfo',
      { headers: { Authorization: 'Bearer token-1' } },
      /refused for a request with credentials/,
    )
    assert.equal(calls.length, 1)
  }
  // The probe's endpoint request counts as carrying credentials.
  calls = await refused(
    { 'https://a.example/sse': [307, 'https://b.example/sse'] },
    'https://a.example/sse',
    {},
    /another origin/,
    { credentials: true },
  )
  assert.equal(calls.length, 1)
  // Same-origin 307 keeps the Authorization header on a GET.
  const net = network({ 'https://a.example/userinfo': [307, '/v2/userinfo'] })
  await followRedirects(
    'https://a.example/userinfo',
    { headers: { Authorization: 'Bearer token-1' } },
    { fetch: net.fetch },
  )
  assert.equal(net.calls[1]!.headers.get('authorization'), 'Bearer token-1')
})
test('301, 302 and 303 are refused for a POST, even on the same origin', async () => {
  for (const status of [301, 302, 303]) {
    const calls = await refused(
      { 'https://a.example/token': [status, '/token2'] },
      'https://a.example/token',
      post(),
      new RegExp(`HTTP ${status} redirect refused`),
    )
    assert.equal(calls.length, 1)
  }
})
test('an unauthenticated GET follows any redirect status to another HTTPS origin', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const net = network({
      'https://veed.example/.well-known/oauth-authorization-server': [
        status,
        'https://www.veed.example/.well-known/oauth-authorization-server',
      ],
    })
    const result = await followRedirects(
      'https://veed.example/.well-known/oauth-authorization-server',
      { headers: { Accept: 'application/json' } },
      { fetch: net.fetch },
    )
    assert.equal(result.response.status, 200)
    assert.equal(
      result.url.href,
      'https://www.veed.example/.well-known/oauth-authorization-server',
    )
    assert.equal(net.calls[1]!.method, 'GET')
    assert.equal(net.calls[1]!.headers.get('accept'), 'application/json')
  }
})
test('every hop is checked: HTTPS, no URL credentials, the test-only origin', async () => {
  await refused(
    { 'https://a.example/x': [301, 'http://a.example/x'] },
    'https://a.example/x',
    {},
    /not HTTPS/,
  )
  await refused(
    { 'https://a.example/x': [301, 'https://u:p@a.example/x'] },
    'https://a.example/x',
    {},
    /credentials/,
  )
  const origin = 'http://127.0.0.1:4100'
  for (const location of [
    'http://127.0.0.1:4101/x',
    'https://a.example/x',
    'http://localhost:4100/x',
  ])
    await refused(
      { [`${origin}/x`]: [302, location] },
      `${origin}/x`,
      {},
      /left the test-only loopback origin/,
      { testOnlyOrigin: origin },
    )
  const net = network({ [`${origin}/mcp`]: [308, '/mcp/'] })
  const result = await followRedirects(`${origin}/mcp`, post(), {
    testOnlyOrigin: origin,
    fetch: net.fetch,
  })
  assert.equal(result.url.href, `${origin}/mcp/`)
})
test('five redirects are followed; a sixth, a loop or a missing Location fails', async () => {
  const chain = (hops: number) =>
    Object.fromEntries(
      Array.from({ length: hops }, (_, i) => [
        `https://a.example/${i}`,
        [302, `/${i + 1}`] as [number, string],
      ]),
    )
  const net = network(chain(5))
  const result = await followRedirects(
    'https://a.example/0',
    {},
    { fetch: net.fetch },
  )
  assert.equal(result.redirects, 5)
  assert.equal(result.url.href, 'https://a.example/5')
  const calls = await refused(
    chain(6),
    'https://a.example/0',
    {},
    /More than 5 redirects/,
  )
  assert.equal(calls.length, 6)
  await refused(
    {
      'https://a.example/a': [302, '/b'],
      'https://a.example/b': [302, 'https://a.example/a'],
    },
    'https://a.example/a',
    {},
    /Redirect loop/,
  )
  await refused(
    { 'https://a.example/a': [307] },
    'https://a.example/a',
    {},
    /HTTP 307 redirect has no Location header/,
  )
})
test('a body that cannot be re-sent fails instead of sending an empty one', async () => {
  const calls = await refused(
    { 'https://a.example/mcp': [307, '/mcp/'] },
    'https://a.example/mcp',
    {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit,
    /body cannot be re-sent/,
  )
  assert.equal(calls.length, 1)
})
test('the server guards follow the shared rule and keep one signal for the whole chain', async () => {
  const net = network({
    'https://a.example/mcp': [308, '/mcp/'],
    'https://a.example/token': [307, 'https://b.example/token'],
  })
  for (const guard of [guardedFetch, upstreamFetch]) {
    net.calls.length = 0
    const response = await guard({ fetch: net.fetch })(
      'https://a.example/mcp',
      post({ Authorization: 'Bearer token-1' }),
    )
    assert.equal(response.status, 200)
    assert.equal(net.calls.length, 2)
    assert.equal(net.calls[1]!.headers.get('authorization'), 'Bearer token-1')
    // guardedFetch's 15-second timeout covers every hop; upstreamFetch has none.
    assert.equal(net.calls[0]!.signal, net.calls[1]!.signal)
    assert.equal(Boolean(net.calls[0]!.signal), guard === guardedFetch)
    await assert.rejects(
      guard({ fetch: net.fetch })('https://a.example/token', post()),
      /another origin/,
    )
  }
})
