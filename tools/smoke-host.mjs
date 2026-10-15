// Host-half smoke test: exercises every registered route against a stub Cordis context,
// so a failure is a test failure here rather than a black screen in the browser.
// Usage: node tools/smoke-host.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const notes = []
function ok(label, detail = '') {
  notes.push(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, detail) {
  failures.push(`  FAIL ${label}: ${detail}`)
}

// A fake harness home so the test never touches the real config file.
const home = mkdtempSync(join(tmpdir(), 'dsh-open-animation-smoke-'))
process.env.DSH_HOME = home

const mod = await import('../index.js')

// --- the Config schema Cordis itself will call -------------------------------------
const schema = mod.Config?.['~standard']
if (!schema?.validate) bad('Config export', 'missing Standard Schema interface')
else {
  const good = schema.validate({ fit: 'contain', skip: 'click' })
  if (good.issues) bad('Config accepts a valid row', JSON.stringify(good.issues))
  else if (good.value.fit !== 'contain' || good.value.skip !== 'click') bad('Config normalizes', JSON.stringify(good.value))
  else ok('Config validates and normalizes a row')

  const empty = schema.validate(undefined)
  if (empty.issues || typeof empty.value !== 'object') bad('Config accepts an absent row', JSON.stringify(empty))
  else ok('Config accepts an absent row')

  const wrong = schema.validate({ fit: 'nope', surprise: 1 })
  if (!wrong.issues || wrong.issues.length !== 2) bad('Config rejects bad rows', JSON.stringify(wrong))
  else ok('Config rejects an unknown key and a bad enum', `${wrong.issues.length} issues`)
}

// --- a stub Cordis context ----------------------------------------------------------
const routes = new Map()
const disposers = []
const ctx = {
  webServer: {
    register(route) {
      const key = `${route.kind} ${route.path}`
      if (routes.has(key)) throw new Error(`duplicate route ${key}`)
      routes.set(key, route.handler)
      const dispose = () => routes.delete(key)
      disposers.push(dispose)
      return dispose
    },
  },
  effect(fn) {
    disposers.push(fn())
    return () => {}
  },
}

let applied = true
try {
  mod.apply(ctx, { src: '', fadeOutMs: 250 })
} catch (error) {
  applied = false
  bad('apply() runs without throwing', error?.stack ?? error)
}
if (applied) ok('apply() runs without throwing', `${routes.size} routes`)

for (const path of ['/dsh-open-animation/state', '/dsh-open-animation/config', '/dsh-open-animation/media', '/dsh-open-animation/pick']) {
  if (!routes.has(`exact ${path}`)) bad('route registered', path)
}
if (routes.size === 4) ok('all four routes registered')

// --- serve them over a real socket ------------------------------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const handler = routes.get(`exact ${url.pathname}`)
  if (!handler) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error))
  })
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string' || !address.port) {
  console.error(`  FAIL test server did not bind to a port: ${JSON.stringify(address)}`)
  process.exit(1)
}
const base = `http://127.0.0.1:${address.port}`

async function get(path, init) {
  const response = await fetch(`${base}${path}`, init)
  const buffer = Buffer.from(await response.arrayBuffer())
  let json = null
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      json = JSON.parse(buffer.toString('utf8'))
    } catch {
      json = null
    }
  }
  return { status: response.status, headers: response.headers, buffer, json }
}

// 1. Default state: the bundled animation must be playable with no configuration at all.
const state = await get('/dsh-open-animation/state')
if (state.status !== 200) bad('GET /state', `HTTP ${state.status}`)
else if (!state.json?.playable) bad('bundled default is playable', JSON.stringify(state.json))
else if (state.json.source.origin !== 'bundled') bad('bundled origin', state.json.source.origin)
else if (!state.json.duration) bad('bundled duration reported', String(state.json.duration))
else ok('GET /state reports the bundled animation', `duration=${state.json.duration}ms`)

// 2. Media bytes must actually be served, with a usable MIME type.
const media = await get('/dsh-open-animation/media')
const mediaType = media.headers.get('content-type') ?? ''
if (media.status !== 200) bad('GET /media', `HTTP ${media.status}`)
else if (!media.buffer.toString('utf8').trimStart().startsWith('<svg')) bad('GET /media body', 'not an SVG')
else if (!mediaType.includes('image/svg+xml')) bad('GET /media content-type', mediaType)
else ok('GET /media serves the artwork', `${media.buffer.length}B, ${mediaType}`)

// 3. Range support is what lets <video> seek.
const ranged = await get('/dsh-open-animation/media', { headers: { range: 'bytes=0-49' } })
if (ranged.status !== 206) bad('range request', `HTTP ${ranged.status}`)
else if (ranged.buffer.length !== 50) bad('range length', `${ranged.buffer.length}B`)
else if (!String(ranged.headers.get('content-range') ?? '').startsWith('bytes 0-49/')) bad('content-range', String(ranged.headers.get('content-range')))
else ok('GET /media honors Range', String(ranged.headers.get('content-range')))

// 4. A configured-but-missing path must NOT fall back to the bundled animation.
const setBad = await get('/dsh-open-animation/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ src: 'Z:/definitely/missing/opening.webm' }),
})
if (setBad.status !== 200) bad('POST /config', `HTTP ${setBad.status}`)
else if (setBad.json?.playable !== false) bad('missing path is not playable', JSON.stringify(setBad.json))
else if (!setBad.json.message) bad('missing path explains itself', JSON.stringify(setBad.json.message))
else ok('a bad path disables playback instead of falling back', setBad.json.message)

// 5. Clearing stays cleared: the saved file must keep an explicitly empty src.
const cleared = await get('/dsh-open-animation/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ src: '' }),
})
if (cleared.status !== 200) bad('POST /config (clear)', `HTTP ${cleared.status}`)
else if (cleared.json?.playable !== false) bad('cleared is not playable', JSON.stringify(cleared.json))
else if (cleared.json.source.configured !== '') bad('cleared src', JSON.stringify(cleared.json.source))
else ok('clearing keeps playback off')

const onDisk = join(home, 'dsh-open-animation', 'config.json')
if (!existsSync(onDisk)) bad('config file written', onDisk)
else {
  const saved = JSON.parse(readFileSync(onDisk, 'utf8'))
  if (saved.src !== '') bad('saved src is an explicit empty string', JSON.stringify(saved.src))
  else ok('config persisted with an explicit empty src', 'config.json')
}

// 6. A real file must resolve and be classified.
const asset = join(home, 'sample.webm')
writeFileSync(asset, Buffer.alloc(2048, 7))
const setGood = await get('/dsh-open-animation/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ src: asset }),
})
if (setGood.json?.playable !== true) bad('a real file is playable', JSON.stringify(setGood.json))
else if (setGood.json.source.kind !== 'video') bad('file classified as video', setGood.json.source.kind)
else ok('a real file resolves and classifies', `${setGood.json.source.kind}, ${setGood.json.source.size}B`)

const videoMedia = await get('/dsh-open-animation/media')
if (videoMedia.status !== 200 || videoMedia.buffer.length !== 2048) bad('serves the custom file', `${videoMedia.status}/${videoMedia.buffer.length}`)
else if (!String(videoMedia.headers.get('content-type')).includes('video/webm')) bad('custom MIME', String(videoMedia.headers.get('content-type')))
else ok('serves the custom file with the right MIME', String(videoMedia.headers.get('content-type')))

// 6b. A non-ASCII path must survive the whole chain: save, read back, resolve, and serve.
//     This is the shape a Chinese Windows user hits, and the picker used to mangle it because
//     Windows PowerShell writes stdout in the OEM code page while Node decodes it as UTF-8.
{
  const dir = join(home, '中文目录')
  mkdirSync(dir, { recursive: true })
  const chinese = join(dir, '开屏动画-测试.webm')
  writeFileSync(chinese, Buffer.alloc(4096, 9))

  const saved = await get('/dsh-open-animation/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: chinese }),
  })
  if (saved.json?.playable !== true) bad('a Chinese path is playable', JSON.stringify(saved.json))
  else if (saved.json.source.path !== chinese) bad('a Chinese path round-trips through JSON', JSON.stringify(saved.json.source.path))
  else if (saved.json.source.name !== '开屏动画-测试.webm') bad('a Chinese filename is preserved', JSON.stringify(saved.json.source.name))
  else ok('a Chinese path survives the save round trip', saved.json.source.name)

  // The bytes on disk must be valid UTF-8, not a lossy re-encoding.
  const onDisk = JSON.parse(readFileSync(join(home, 'dsh-open-animation', 'config.json'), 'utf8'))
  if (onDisk.src !== chinese) bad('config.json stores the Chinese path losslessly', JSON.stringify(onDisk.src))
  else ok('config.json stores the Chinese path losslessly')

  const served = await get('/dsh-open-animation/media')
  if (served.status !== 200 || served.buffer.length !== 4096) bad('serves a Chinese-named file', `${served.status}/${served.buffer.length}`)
  else ok('serves a Chinese-named file')

  // A filename the picker might return with a full-width character and a space.
  const spaced = join(dir, '开屏 动画 （副本）.webm')
  writeFileSync(spaced, Buffer.alloc(1024, 3))
  const savedSpaced = await get('/dsh-open-animation/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: spaced }),
  })
  if (savedSpaced.json?.source?.path !== spaced) bad('a path with spaces and full-width characters', JSON.stringify(savedSpaced.json?.source?.path))
  else ok('a path with spaces and full-width characters round-trips')

  // Put the config back so later checks see a known source.
  await get('/dsh-open-animation/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: asset }),
  })
}

// 7. An unsupported extension must not be treated as playable media.
const odd = join(home, 'notes.txt')
writeFileSync(odd, 'hello')
const setOdd = await get('/dsh-open-animation/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ src: odd }),
})
if (setOdd.json?.playable !== false) bad('unsupported extension is not playable', JSON.stringify(setOdd.json))
else ok('an unsupported extension is refused', setOdd.json.message)

// 8. Config clamping: bad numbers fall back to the row config instead of producing NaN.
const clamped = await get('/dsh-open-animation/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ src: asset, fadeOutMs: 'nonsense', volume: 99, fit: 'bogus', maxReplays: -4 }),
})
const cfg = clamped.json?.config
if (!cfg) bad('POST /config returns config', JSON.stringify(clamped.json))
else if (cfg.fadeOutMs !== 250) bad('fadeOutMs falls back to the row config', String(cfg.fadeOutMs))
else if (cfg.volume !== 1) bad('volume clamps to 1', String(cfg.volume))
else if (cfg.fit !== 'cover') bad('fit falls back', cfg.fit)
else if (cfg.maxReplays !== 0) bad('maxReplays clamps', String(cfg.maxReplays))
else ok('out-of-range values fall back to the row config / defaults')

// 9. HEAD and 404 behaviour.
const head = await get('/dsh-open-animation/media', { method: 'HEAD' })
if (head.status !== 200 || head.buffer.length !== 0) bad('HEAD /media', `${head.status}/${head.buffer.length}`)
else ok('HEAD /media answers without a body')

// 10. Disposal must unregister every route (the effect owns them).
for (const dispose of disposers) dispose()
if (routes.size !== 0) bad('routes disposed', `${routes.size} still registered`)
else ok('disposal unregisters every route')

// 11. The picker contract: a dismissed dialog is not an error, and every real failure
//     carries a reason the settings page can act on. The route itself is not called here
//     because on Windows that would open a real dialog.
{
  const cases = [
    [{ ok: false, reason: 'cancelled', error: '已取消' }, (b) => b.cancelled === true && b.ok === false, 'a dismissed dialog is not an error'],
    [{ ok: false, reason: 'not-found', error: '找不到 powershell.exe' }, (b) => b.cancelled === false && b.reason === 'not-found' && Boolean(b.error), 'a missing binary reports its reason'],
    [{ ok: false, reason: 'unsupported', error: '请直接粘贴路径' }, (b) => b.cancelled === false && b.reason === 'unsupported', 'an unsupported platform reports its reason'],
    [{ ok: false }, (b) => b.cancelled === false && b.reason === 'failed' && Boolean(b.error), 'an unknown failure still explains itself'],
  ]
  for (const [input, assert, label] of cases) {
    const out = mod.pickOutcome(input)
    if (out.status !== 200) bad(`pick outcome (${label})`, `status ${out.status}`)
    else if (!assert(out.body)) bad(`pick outcome (${label})`, JSON.stringify(out.body))
    else ok(`pick outcome: ${label}`)
  }

  const good = mod.pickOutcome({ ok: true, path: join(root, 'assets', 'opening.svg') })
  if (!good.body.ok || good.body.kind !== 'image' || !good.body.supported || !good.body.size) {
    bad('pick outcome (accepted file)', JSON.stringify(good.body))
  } else ok('pick outcome: an accepted file is classified', `${good.body.kind}, ${good.body.size}B`)

  const junk = mod.pickOutcome({ ok: true, path: join(root, 'README.md') })
  if (junk.body.supported !== false) bad('pick outcome (unsupported extension)', JSON.stringify(junk.body))
  else ok('pick outcome: an unrecognized extension is flagged, not accepted')
}

server.close()
rmSync(home, { recursive: true, force: true })

// --- row-config layer, with no saved file at all ------------------------------------
// This is the shape the harness actually uses: every value arrives from cordis.patch.yml.
{
  const home2 = mkdtempSync(join(tmpdir(), 'dsh-open-animation-row-'))
  process.env.DSH_HOME = home2
  const { apply } = await import(`../index.js?row=${Date.now()}`)

  const rowRoutes = new Map()
  const rowCtx = {
    webServer: {
      register(route) {
        rowRoutes.set(`${route.kind} ${route.path}`, route.handler)
        return () => rowRoutes.delete(`${route.kind} ${route.path}`)
      },
    },
    effect: (fn) => fn(),
  }

  let threw = null
  try {
    apply(rowCtx, { src: join(root, 'assets', 'opening.svg'), fit: 'contain', muted: false, fadeOutMs: 900 })
  } catch (error) {
    threw = error
  }
  if (threw) bad('apply() accepts a full row config', threw?.message ?? String(threw))
  else {
    const handler = rowRoutes.get('exact /dsh-open-animation/state')
    const response = await new Promise((resolve) => {
      // The trust fence requires a Host header, exactly as a real request carries one.
      const req = { method: 'GET', url: '/dsh-open-animation/state', headers: { host: '127.0.0.1:1234' } }
      const res = {
        statusCode: 0,
        headers: {},
        body: '',
        writeHead(status, headers) {
          this.statusCode = status
          this.headers = headers ?? {}
          return this
        },
        end(chunk) {
          if (chunk) this.body += chunk.toString('utf8')
          resolve(this)
        },
      }
      Promise.resolve(handler(req, res)).catch((error) => bad('row /state handler', error?.message ?? String(error)))
    })
    let payload = null
    try {
      payload = JSON.parse(response.body)
    } catch {
      payload = null
    }
    if (!payload) bad('row config /state returns JSON', response.body?.slice(0, 120))
    else if (payload.config.fit !== 'contain' || payload.config.muted !== false || payload.config.fadeOutMs !== 900) {
      bad('row config values reach the client', JSON.stringify(payload.config))
    } else if (payload.playable !== true || payload.source.origin !== 'custom') {
      bad('row config src resolves', JSON.stringify(payload.source))
    } else ok('a cordis.patch.yml row config drives the plugin', `fit=${payload.config.fit} fadeOutMs=${payload.config.fadeOutMs}`)
  }

  rmSync(home2, { recursive: true, force: true })
}

// 12. The trust fence replaces the identity check `/api` used to provide: a route served
//     outside `/api` is reachable by any local process, so cross-site and rebinding
//     requests must be refused before the handler runs.
{
  const cases = [
    [{ host: '127.0.0.1:1234' }, true, 'a loopback Host is admitted'],
    [{ host: 'localhost:19387' }, true, 'localhost is admitted'],
    [{ host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' }, true, 'a same-origin Origin is admitted'],
    [{ host: '127.0.0.1:1234', 'sec-fetch-site': 'same-origin' }, true, 'a same-origin fetch site is admitted'],
    [{ host: 'evil.example.com' }, false, 'a foreign Host is refused (DNS rebinding)'],
    [{}, false, 'a missing Host is refused'],
    [{ host: '127.0.0.1:1234', origin: 'http://evil.example.com' }, false, 'a foreign Origin is refused'],
    [{ host: '127.0.0.1:1234', 'sec-fetch-site': 'cross-site' }, false, 'a cross-site fetch is refused'],
    [{ host: '127.0.0.1:1234', origin: 'not a url' }, false, 'a malformed Origin is refused'],
  ]
  for (const [headers, admitted, label] of cases) {
    const rejection = mod.rejectUntrusted({ headers })
    if (admitted && rejection) bad(`trust fence (${label})`, `unexpectedly refused: ${rejection}`)
    else if (!admitted && !rejection) bad(`trust fence (${label})`, 'unexpectedly admitted')
    else ok(`trust fence: ${label}`)
  }

  // An explicit trusted host is the only way a non-loopback authority is admitted.
  const trusted = mod.rejectUntrusted({ headers: { host: 'harness.lan:19387' } }, ['harness.lan'])
  if (trusted) bad('trust fence (configured trustedHosts)', trusted)
  else ok('trust fence: a configured trustedHosts entry is admitted')
}

console.log(notes.join('\n'))
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nhost half smoke test passed')
