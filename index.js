/**
 * dsh-open-animation — Host half.
 *
 * Owns three things:
 *   1. the persisted splash configuration (one JSON file under the harness home),
 *   2. the HTTP surface the Client half talks to: config read/write, media bytes,
 *      and a native file picker,
 *   3. the row's Config defaults, so `cordis.patch.yml` overrides still work.
 *
 * The visual half lives entirely in `client.js`. This module never touches the DOM.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Row id this bundle's patch inserts. Also the route namespace. */
const ROW_ID = 'dsh-open-animation'
/** Directory name under the harness home that holds `config.json`. */
const STATE_DIRNAME = 'dsh-open-animation'
/**
 * Route namespace. Deliberately NOT under `/api`: the Web carrier's Connection service owns
 * the sole `/api` route and authenticates every request under it with its signed browser
 * cookie, so a plugin route registered on `webServer` under `/api/...` is unreachable —
 * the request never reaches the webserver's route table. A top-level prefix like this one
 * goes straight to `webServer`, which is how the browser can fetch it at all. The trust
 * fence below replaces the identity check with the same origin rules Connection applies.
 */
const ROUTE_BASE = `/${ROW_ID}`
const PICK_TIMEOUT_MS = 5 * 60 * 1000

const FITS = ['cover', 'contain', 'fill']
const SKIPS = ['button', 'click', 'auto', 'never']

/** Config defaults, also the key set `Config` accepts. */
const CONFIG_DEFAULTS = {
  src: '',
  autoplay: true,
  muted: true,
  volume: 0.6,
  fit: 'cover',
  background: '#000000',
  fadeInMs: 0,
  fadeOutMs: 300,
  holdAfterEndMs: 0,
  skip: 'button',
  skipAfterMs: 1200,
  playbackRate: 1,
  duration: 0,
  maxReplays: 0,
  waitForAppMs: 2500,
  coverBeforePaint: true,
  fallbackRemoveMs: 10000,
  // Host-side only. Not an animation setting, but a real config field so that editing it in
  // the patch file validates and shows up in the schema instead of being rejected.
  trustedHosts: [],
}

const KINDS = {
  video: new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv', '.ogm', '.mpg', '.mpeg', '.ts']),
  image: new Set(['.gif', '.apng', '.webp', '.avif', '.png', '.jpg', '.jpeg', '.svg', '.bmp', '.ico']),
}

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.ogm': 'video/ogg',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.gif': 'image/gif',
  '.apng': 'image/apng',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

const PICK_FILTER = 'Media files|*.mp4;*.m4v;*.webm;*.mov;*.mkv;*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp|All files|*.*'

/**
 * Windows picker, run as a `-EncodedCommand` payload.
 *
 * Deliberately not `-File <temp.ps1>`: the temp file has to survive a sandboxed write and
 * be readable by a separate process, and a base64 `-EncodedCommand` sidesteps both the temp
 * directory and any non-ASCII encoding problem in the script text.
 *
 * The two encoding lines are load-bearing, not hygiene. Windows PowerShell 5.1 encodes the
 * process's stdout with the console's OEM code page — 936/GBK on a Chinese system — while
 * Node decodes it as UTF-8. Without this, a path containing any non-ASCII character comes
 * back as mojibake and the material can never be found. `$OutputEncoding` governs what
 * PowerShell passes to a native command; `[Console]::OutputEncoding` governs its own writes.
 */
const PS_PICKER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择开屏动画素材'
$dialog.Filter = '${PICK_FILTER}'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$window = New-Object System.Windows.Forms.Form
$window.TopMost = $true
$window.ShowInTaskbar = $false
$window.Opacity = 0
$window.Show()
$window.Activate()
$answer = $dialog.ShowDialog($window)
$window.Close()
if ($answer -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.FileName)
  exit 0
}
exit 1
`

/** POSIX pickers; the same stdout contract as the Windows one. */
const POSIX_PICKERS = {
  darwin: {
    command: 'osascript',
    args: ['-e', 'POSIX path of (choose file with prompt "选择开屏动画素材")'],
  },
  linux: {
    command: 'zenity',
    args: ['--file-selection', '--title=选择开屏动画素材'],
  },
}

function clamp(value, low, high, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(high, Math.max(low, n))
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/** Normalize any untrusted config patch into the exact shape the Client half consumes. */
function normalize(raw, base = CONFIG_DEFAULTS) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const pick = (key) => (key in input ? input[key] : base[key])
  return {
    src: typeof pick('src') === 'string' ? pick('src').trim() : base.src,
    autoplay: Boolean(pick('autoplay')),
    muted: Boolean(pick('muted')),
    volume: clamp(pick('volume'), 0, 1, base.volume),
    fit: oneOf(pick('fit'), ['cover', 'contain', 'fill'], base.fit),
    background: typeof pick('background') === 'string' && pick('background').trim() ? pick('background').trim() : base.background,
    fadeInMs: clamp(pick('fadeInMs'), 0, 60000, base.fadeInMs),
    fadeOutMs: clamp(pick('fadeOutMs'), 0, 60000, base.fadeOutMs),
    holdAfterEndMs: clamp(pick('holdAfterEndMs'), 0, 600000, base.holdAfterEndMs),
    skip: oneOf(pick('skip'), ['button', 'click', 'auto', 'never'], base.skip),
    skipAfterMs: clamp(pick('skipAfterMs'), 0, 600000, base.skipAfterMs),
    playbackRate: clamp(pick('playbackRate'), 0.1, 4, base.playbackRate),
    duration: clamp(pick('duration'), 0, 3600000, base.duration),
    maxReplays: Math.round(clamp(pick('maxReplays'), 0, 100, base.maxReplays)),
    waitForAppMs: clamp(pick('waitForAppMs'), 0, 60000, base.waitForAppMs),
    coverBeforePaint: Boolean(pick('coverBeforePaint')),
    fallbackRemoveMs: clamp(pick('fallbackRemoveMs'), 1000, 120000, base.fallbackRemoveMs),
    trustedHosts: Array.isArray(pick('trustedHosts'))
      ? pick('trustedHosts').map((entry) => String(entry).trim()).filter(Boolean)
      : base.trustedHosts,
  }
}

/**
 * The row's config schema, in Standard Schema v1 form — the only dialect Cordis reads
 * (`runtime.Config['~standard'].validate(config)`). Hand-rolled so the package needs no
 * dependency: a Cordis profile resolves nothing but the plugin itself.
 *
 * Unknown keys are rejected loudly, so a typo in `cordis.patch.yml` surfaces instead of
 * silently doing nothing. Every known key is normalized on the way through.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-open-animation',
    validate(value) {
      const issues = []
      const input = value === undefined || value === null ? {} : value
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const key of Object.keys(input)) {
        if (key in CONFIG_DEFAULTS) continue
        issues.push({ message: `unknown config key "${key}"`, path: [key] })
      }
      if ('fit' in input && !FITS.includes(input.fit)) {
        issues.push({ message: `must be one of ${FITS.join(' | ')}`, path: ['fit'] })
      }
      if ('skip' in input && !SKIPS.includes(input.skip)) {
        issues.push({ message: `must be one of ${SKIPS.join(' | ')}`, path: ['skip'] })
      }
      if ('src' in input && typeof input.src !== 'string') {
        issues.push({ message: 'must be a string path', path: ['src'] })
      }
      if ('background' in input && typeof input.background !== 'string') {
        issues.push({ message: 'must be a CSS color', path: ['background'] })
      }
      if ('trustedHosts' in input && !Array.isArray(input.trustedHosts)) {
        issues.push({ message: 'must be an array of host names', path: ['trustedHosts'] })
      }
      if (issues.length) return { issues }
      return { value: normalize(input, CONFIG_DEFAULTS) }
    },
  },
}

// end of host half

/** `~`, relative paths, and Windows separators all have to work from a settings text box. */
function expandUserPath(input) {
  const text = String(input ?? '').trim().replace(/^"|"$/g, '')
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text) ? text : resolve(text)
}

function classify(path) {
  const ext = extname(path).toLowerCase()
  if (KINDS.video.has(ext)) return 'video'
  if (KINDS.image.has(ext)) return 'image'
  return ''
}

/** Loads and saves the config file, falling back to the row config when absent. */
class Store {
  constructor(rowConfig) {
    this.base = normalize(rowConfig, CONFIG_DEFAULTS)
    this.file = ''
    this.saved = null
  }

  /** Bind to a harness home; called once during apply(). */
  mount(home) {
    const dir = join(home, STATE_DIRNAME)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // A read-only home still lets the plugin run with row-config defaults.
    }
    this.file = join(dir, 'config.json')
    try {
      if (existsSync(this.file)) {
        this.saved = JSON.parse(readFileSync(this.file, 'utf8'))
      }
    } catch {
      this.saved = null
    }
  }

  /** The effective config: defaults, then the row config, then the saved file. */
  read() {
    const merged = { ...this.base }
    if (this.saved && typeof this.saved === 'object') {
      const patch = normalize(this.saved, merged)
      // An explicitly empty `src` in the saved file means "off", so it must survive.
      Object.assign(merged, patch, { src: typeof this.saved.src === 'string' ? this.saved.src.trim() : merged.src })
    }
    // `trustedHosts` is a deployment concern, not a user preference: it always comes from
    // the row config, so editing the patch file takes effect even though the settings page
    // persists a config file next to it.
    merged.trustedHosts = this.base.trustedHosts
    return merged
  }

  /** Whether a saved config exists at all — the difference between "never set" and "cleared". */
  hasSaved() {
    return Boolean(this.saved && typeof this.saved === 'object')
  }

  write(patch) {
    const next = normalize({ ...this.read(), ...patch }, this.read())
    // Never persist the host-only field: the file holds the user's animation choices, and
    // `trustedHosts` stays owned by the patch layer where it is reviewed.
    delete next.trustedHosts
    this.saved = next
    if (this.file) {
      try {
        const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
        writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        renameSync(tmp, this.file)
      } catch (error) {
        return { ok: false, error: `无法写入配置：${error?.message ?? error}` }
      }
    }
    return { ok: true }
  }
}

const BUNDLED_ASSET = 'assets/opening.svg'

/** Resolve one named path into a playable source, or a diagnosis explaining why not. */
function namedSource(src) {
  const candidate = expandUserPath(src)
  try {
    const info = statSync(candidate)
    if (info.isFile()) return { path: candidate, kind: classify(candidate), origin: 'custom', configured: src, size: info.size }
    return { path: '', kind: '', origin: 'custom', configured: src, error: '这是一个目录，不是文件' }
  } catch {
    return { path: '', kind: '', origin: 'custom', configured: src, error: '找不到这个文件' }
  }
}

function bundledSource(pluginDir) {
  const bundled = join(pluginDir, BUNDLED_ASSET)
  if (!existsSync(bundled)) {
    return { path: '', kind: '', origin: 'none', configured: '', error: '插件自带的素材缺失' }
  }
  return { path: bundled, kind: 'image', origin: 'bundled', configured: '', size: statSync(bundled).size }
}

/**
 * Decide what to play, across three layers, where an empty `src` means different things:
 *   - a query override          → preview an unsaved path;
 *   - the saved config          → the user's choice, and an explicit empty string means
 *                                 "off" rather than "unset", so it must NOT roll back;
 *   - the row config (patch)    → the developer default, where an empty string means
 *                                 "not configured", so the bundled asset plays instead.
 * Playing the bundled asset is therefore only correct when no layer ever named a source.
 */
function resolveSource(store, pluginDir, override) {
  if (typeof override === 'string' && override.trim()) return namedSource(override.trim())
  if (store.hasSaved()) {
    const saved = store.read().src
    return saved ? namedSource(saved) : { path: '', kind: '', origin: 'off', configured: '', error: '' }
  }
  const fromRow = store.base.src
  return fromRow ? namedSource(fromRow) : bundledSource(pluginDir)
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Trust fence for this plugin's routes, mirroring what the Connection service enforces
 * before it dispatches `/api` requests: the `Host` must name this machine, an attached
 * `Origin` must equal that `Host`, and `sec-fetch-site: cross-site` is refused. These
 * checks defeat DNS rebinding and cross-site requests from other pages; they do not
 * establish user identity, which loopback HTTP cannot do anyway.
 *
 * Returns a rejection message, or `''` when the request is admissible.
 */
export function rejectUntrusted(req, trustedHosts = []) {
  const host = String(req.headers.host ?? '').trim().toLowerCase()
  if (!host) return 'missing Host'

  const normalize = (value) => {
    try {
      return new URL(`http://${value}`).host.toLowerCase()
    } catch {
      return ''
    }
  }
  const hostPort = normalize(host)
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
  const trusted = trustedHosts.some((entry) => {
    const wanted = normalize(entry)
    if (!wanted) return false
    // A port-less entry accepts any port, matching the Connection rule.
    return entry.includes(':') ? wanted === hostPort : wanted.split(':')[0] === hostPort.split(':')[0]
  })
  if (!loopback.test(hostPort) && !trusted) return `untrusted Host ${host}`

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.trim()) {
    let originHost = ''
    try {
      originHost = new URL(origin).host.toLowerCase()
    } catch {
      return 'malformed Origin'
    }
    if (originHost !== hostPort) return 'cross-origin request'
  }

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') return 'cross-site request'
  return ''
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolvePromise({})
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolvePromise({})
      }
    })
    req.on('error', () => resolvePromise({}))
  })
}

/** Stream a file with Range support so `<video>` can seek. */
function streamFile(req, res, file) {
  let info
  try {
    info = statSync(file)
  } catch {
    sendJson(res, 404, { error: 'not-found' })
    return
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  const range = req.headers.range
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (match) {
    const hasStart = match[1] !== ''
    const hasEnd = match[2] !== ''
    let start = hasStart ? Number(match[1]) : 0
    let end = hasEnd ? Number(match[2]) : info.size - 1
    if (!hasStart && hasEnd) {
      start = Math.max(0, info.size - Number(match[2]))
      end = info.size - 1
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}` })
      res.end()
      return
    }
    end = Math.min(end, info.size - 1)
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'content-length': end - start + 1,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': info.size })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

/**
 * PowerShell writes progress records to stderr as CLIXML even on success, so raw stderr is
 * unreadable in a settings page. Keep only text a human can act on.
 */
function cleanStderr(stderr) {
  const text = String(stderr ?? '')
  if (text.trimStart().startsWith('#< CLIXML')) {
    const withoutXml = text.replace(/#< CLIXML[\s\S]*$/m, '')
    if (!withoutXml.trim()) return ''
    return withoutXml.trim()
  }
  return text.trim()
}

/** Describe a failed spawn in a way that says what to do about it, not just what broke. */
function explainSpawnFailure(command, error, stderr) {
  const detail = cleanStderr(stderr).split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' / ')
  if (error?.killed) return { reason: 'no-response', error: '选择框没有响应（可能没有可交互的桌面会话），请直接把路径粘贴到输入框' }
  if (error?.code === 'ENOENT') return { reason: 'not-found', error: `找不到 ${command}，请直接把路径粘贴到输入框` }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return { reason: 'denied', error: `没有权限运行 ${command}，请直接把路径粘贴到输入框` }
  if (detail) return { reason: 'script-error', error: `选择器无法启动：${detail}` }
  return { reason: error?.code ?? 'failed', error: `选择器无法启动（${error?.code ?? error?.message ?? '未知原因'}）` }
}

/**
 * Candidate PowerShell hosts, in preference order. A harness process does not necessarily
 * inherit the same PATH a terminal has, so the absolute System32 path is tried too.
 */
const PS_CANDIDATES = [
  'powershell.exe',
  'pwsh.exe',
  `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
]

/** Run one command to completion, reporting the interesting parts of the outcome. */
function runOnce(command, args, timeout) {
  return new Promise((resolvePromise) => {
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    let child
    try {
      child = execFile(command, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
        settle({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    } catch (error) {
      settle({ error, stdout: '', stderr: '' })
      return
    }
    child.on('error', (error) => settle({ error, stdout: '', stderr: '' }))
  })
}

/**
 * Pick the first PowerShell host that actually runs. A probe costs a few hundred
 * milliseconds and turns an opaque spawn failure into a precise "none of these exist".
 */
async function resolveWindowsPicker() {
  const base64 = Buffer.from(PS_PICKER, 'utf16le').toString('base64')
  const attempts = []
  for (const candidate of PS_CANDIDATES) {
    const probe = await runOnce(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], 15000)
    if (!probe.error) return { command: candidate, args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', base64] }
    attempts.push(`${candidate} (${probe.error.code ?? probe.error.message ?? 'failed'})`)
  }
  return { error: `没有可用的 PowerShell：${attempts.join('、')}` }
}

/**
 * Open a native file dialog. Returns the chosen path, or an explanation the settings page
 * can show. A dialog cannot be opened from a non-interactive session, so every failure
 * path tells the user that typing the path is still possible.
 */
async function pickFile() {
  if (process.platform === 'win32') {
    const resolved = await resolveWindowsPicker()
    if (resolved.error) return { ok: false, reason: 'not-found', error: `${resolved.error}，请直接把路径粘贴到输入框` }
    const { command, args } = resolved
    const result = await runOnce(command, args, PICK_TIMEOUT_MS)
    const chosen = result.stdout.trim()
    if (chosen) return { ok: true, path: chosen }
    if (!result.error) return { ok: false, reason: 'cancelled', error: '已取消' }
    return { ok: false, ...explainSpawnFailure(command, result.error, result.stderr) }
  }

  const posix = POSIX_PICKERS[process.platform]
  if (!posix) {
    return { ok: false, reason: 'unsupported', error: `这个平台（${process.platform}）没有内置的文件选择器，请直接粘贴路径` }
  }
  const result = await runOnce(posix.command, posix.args, PICK_TIMEOUT_MS)
  const chosen = result.stdout.trim()
  if (chosen) return { ok: true, path: chosen }
  if (!result.error) return { ok: false, reason: 'cancelled', error: '已取消' }
  return { ok: false, ...explainSpawnFailure(posix.command, result.error, result.stderr) }
}

/** The bundled animation is a 3.2 s SVG, which has no `ended` event of its own. */
const BUNDLED_DURATION_MS = 3200

/**
 * Shape one picker outcome into the response the settings page reads. Kept separate from
 * the route so the whole contract is unit-testable without opening a real dialog.
 */
export function pickOutcome(result) {
  if (!result.ok) {
    return {
      status: 200,
      body: {
        ok: false,
        cancelled: result.reason === 'cancelled',
        reason: result.reason ?? 'failed',
        error: result.error ?? '打不开文件选择框',
      },
    }
  }
  let size = 0
  try {
    size = statSync(result.path).size
  } catch {
    size = 0
  }
  return {
    status: 200,
    body: {
      ok: true,
      path: result.path,
      name: basename(result.path),
      kind: classify(result.path),
      size,
      supported: Boolean(classify(result.path)),
    },
  }
}

/** Cordis calls this with the row's config; every registration is owned by the caller's effect. */
export function apply(ctx, rowConfig) {
  // The host logger when there is one; a plain console otherwise. Startup is the only
  // moment this plugin can explain itself, so the important paths are reported once.
  const log = {
    info: (message) => (ctx?.logger?.info ? ctx.logger.info(message) : console.log(`[dsh-open-animation] ${message}`)),
    warn: (message) => (ctx?.logger?.warn ? ctx.logger.warn(message) : console.warn(`[dsh-open-animation] ${message}`)),
  }

  const store = new Store(rowConfig)
  // `trustedHosts` is host-only: it must never travel to the browser, so it is read from the
  // resolved config and then dropped from what the settings page sees.
  const trustedHosts = store.read().trustedHosts
  // dsh-home-paths resolves the same way and the same order: $DSH_HOME when it holds a
  // non-blank value, then ~/.dsh. A Cordis Context is a proxy that THROWS on an undeclared
  // property, so the harness home must never be read as `ctx.dshHome` — it is not a Service.
  const configuredEnv = process.env.DSH_HOME
  const home = resolve(configuredEnv?.trim() ? configuredEnv : join(homedir(), '.dsh'))
  store.mount(home)

  // The package directory is where this module lives; the bundled asset sits beside it.
  const pluginDir = dirname(fileURLToPath(import.meta.url))

  const state = () => {
    const source = resolveSource(store, pluginDir, '')
    // `trustedHosts` is a host-only trust setting; the browser has no business knowing it.
    const { trustedHosts: _hostOnly, ...config } = store.read()
    const kind = source.kind
    const playable = Boolean(source.path && kind)
    let message = ''
    if (source.error) message = source.error
    else if (source.origin === 'off') message = '未设置素材，开屏动画已关闭'
    else if (!source.path) message = '没有可用的开屏素材'
    else if (!kind) message = `无法识别这个格式：${extname(source.path) || '(无扩展名)'}`
    return {
      config,
      source: {
        origin: source.origin,
        configured: source.configured,
        path: source.path,
        name: source.path ? basename(source.path) : '',
        kind,
        size: source.size ?? 0,
        exists: Boolean(source.path),
      },
      playable,
      // An animated image never fires `ended`, so the host tells the Client how long the
      // current source runs for. The bundled SVG carries its own length.
      duration: config.duration > 0 ? config.duration : source.origin === 'bundled' ? BUNDLED_DURATION_MS : 0,
      message,
      mediaUrl: playable ? `${ROUTE_BASE}/media` : '',
    }
  }

  {
    // One startup line so a broken install is diagnosable from the host log alone.
    const startup = state()
    const what = startup.playable
      ? `${startup.source.origin === 'bundled' ? '自带动画' : startup.source.name}（${startup.source.kind}）`
      : `不播放 — ${startup.message}`
    log.info(`开屏动画已就绪：${what}；状态文件 ${store.file}`)
  }

  ctx.effect(() => {
    const disposers = []

    // One wrapper applies the trust fence to every route below.
    const route = (path, handler) => {
      let dispose
      try {
        dispose = ctx.webServer.register({
          kind: 'exact',
          path,
          handler: (req, res) => {
            const rejection = rejectUntrusted(req, trustedHosts)
            if (rejection) {
              log.warn(`拒绝请求 ${path}：${rejection}`)
              sendJson(res, 403, { ok: false, error: rejection })
              return
            }
            return handler(req, res)
          },
        })
      } catch (error) {
        log.warn(`路由 ${path} 注册失败：${error?.message ?? error}`)
        return
      }
      disposers.push(dispose)
    }

    route(`${ROUTE_BASE}/state`, (req, res) => {
      sendJson(res, 200, { ok: true, ...state() })
    })

    route(`${ROUTE_BASE}/config`, async (req, res) => {
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readJsonBody(req)
        const before = store.read()
        const written = store.write(body ?? {})
        if (!written.ok) {
          log.warn(`保存配置失败：${written.error}`)
          sendJson(res, 500, { ok: false, error: written.error, ...state() })
          return
        }
        log.info(`配置已保存：src=${JSON.stringify(store.read().src)}`)
        // Re-resolve after the change so the caller learns whether the new path works.
        const after = state()
        sendJson(res, 200, {
          ok: true,
          changed: JSON.stringify(before) !== JSON.stringify(after.config),
          ...after,
        })
        return
      }
      sendJson(res, 200, { ok: true, ...state() })
    })

    route(`${ROUTE_BASE}/media`, (req, res) => {
      const override = (() => {
        const url = req.url ?? ''
        const at = url.indexOf('?')
        if (at < 0) return ''
        const query = new URLSearchParams(url.slice(at + 1))
        return query.get('src') ?? ''
      })()
      const source = resolveSource(store, pluginDir, override)
      if (!source.path || !classify(source.path)) {
        sendJson(res, 404, { ok: false, error: source.error ?? 'no media' })
        return
      }
      streamFile(req, res, source.path)
    })

    route(`${ROUTE_BASE}/pick`, async (req, res) => {
      const outcome = pickOutcome(await pickFile())
      if (!outcome.body.ok && !outcome.body.cancelled) log.warn(`文件选择器不可用（${outcome.body.reason}）：${outcome.body.error}`)
      sendJson(res, outcome.status, outcome.body)
    })

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A route whose webServer already went away needs no cleanup.
        }
      }
    }
  })
}

export const inject = ['webServer']
