// Local pre-install checks: parse every JS module, validate JSON manifests, and
// confirm the bundle's own patch and assets are present and well formed.
// Usage: node tools/verify.mjs
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function check(label, fn) {
  try {
    fn()
    notes.push(`  ok   ${label}`)
  } catch (error) {
    failures.push(`  FAIL ${label}: ${error?.message ?? error}`)
  }
}

// 1. Every JavaScript file in the package must parse as an ES module. `node --check` with the
//    module input type is syntax-only: it never executes the file and never resolves its
//    imports. The source arrives on stdin because --input-type is only accepted for
//    stdin/eval input. The tool list is discovered rather than hardcoded, so a new script
//    cannot slip in unchecked.
const sources = ['index.js', 'client.js']
for (const entry of readdirSync(join(root, 'tools'))) {
  if (entry.endsWith('.mjs')) sources.push(join('tools', entry))
}
for (const file of sources) {
  check(`${file} parses as an ES module`, () => {
    execFileSync(process.execPath, ['--check', '--input-type=module'], {
      input: readFileSync(join(root, file)),
      stdio: ['pipe', 'ignore', 'pipe'],
    })
  })
}

// 2. Manifests and locale files must be valid JSON with the fields the loader reads.
for (const file of ['package.json', join('locale', 'zh.json'), join('locale', 'en.json')]) {
  check(`${file} is valid JSON`, () => {
    const parsed = JSON.parse(readFileSync(join(root, file), 'utf8'))
    if (file !== 'package.json') {
      if (!parsed.title || !parsed.description) throw new Error('locale file needs title + description')
      return
    }
    if (!parsed.dsh?.bundle?.patch) throw new Error('missing dsh.bundle.patch')
    if (parsed.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform must be "web"')
    if (parsed.dsh?.client?.immediately !== true) throw new Error('dsh.client.immediately must be true')
    if (!Array.isArray(parsed.dsh?.client?.inject)) throw new Error('dsh.client.inject must be an array')
    if (parsed.exports?.['.'] !== './index.js') throw new Error('missing . export')
    if (parsed.exports?.['./client'] !== './client.js') throw new Error('missing ./client export')
    if (!parsed.icon) throw new Error('missing icon')
    if (!parsed.meta?.title) throw new Error('missing meta.title')
    if (parsed.name !== 'dsh-open-animation') throw new Error('name must match the factory id in client.js')
  })
}

// 3. The patch must insert exactly the one row this package provides.
check('cordis.patch.yml inserts exactly one matching row', () => {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  if (!/^-\s*insert:/m.test(text)) throw new Error('no top-level `- insert:` entry')
  if (!/^\s*-\s*id:\s*dsh-open-animation\s*$/m.test(text)) throw new Error('no row with id: dsh-open-animation')
  if (!/^\s*name:\s*'?dsh-open-animation'?\s*$/m.test(text)) throw new Error('no row with name: dsh-open-animation')
  const rows = text.split('\n').filter((line) => /^\s*-\s*id:/.test(line))
  if (rows.length !== 1) throw new Error(`expected exactly 1 inserted row, found ${rows.length}`)
})

// 4. The client factory id must equal the package name, or the bundle never materialises.
check('client.js registers the package-name factory', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!source.includes(`id: '${pkg.name}'`)) throw new Error(`client.js must load({ id: '${pkg.name}' })`)
  if (!source.includes('window.__ModuleLoader__.load(')) throw new Error('missing __ModuleLoader__.load call')
  if (!source.includes('factory(require)')) throw new Error('missing factory(require) signature')
  if (!source.includes("require('react')")) throw new Error('React must come from the browser module table')
})

// 5. The bundled asset the host falls back to must exist and be a complete SVG.
check('bundled asset exists', () => {
  const file = join(root, 'assets', 'opening.svg')
  if (!existsSync(file)) throw new Error('assets/opening.svg is missing')
  if (statSync(file).size < 500) throw new Error('assets/opening.svg looks empty')
  const text = readFileSync(file, 'utf8')
  if (!text.trimStart().startsWith('<svg')) throw new Error('assets/opening.svg is not an SVG document')
  if (!text.includes('</svg>')) throw new Error('assets/opening.svg is truncated')
})

// 6. Host and client must agree on the route namespace and its endpoints.
check('host routes match the client route base', () => {
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  // The host builds its base from ROW_ID, so resolve that first.
  const rowId = /const ROW_ID = '([^']+)'/.exec(host)?.[1]
  const rawHostBase = /const ROUTE_BASE = `\/([^`]+)`/.exec(host)?.[1]
  if (!rowId || !rawHostBase) throw new Error('could not read ROW_ID / ROUTE_BASE from the host half')
  const hostBase = rawHostBase.replace('${ROW_ID}', rowId)
  const clientBase = /const ROUTE_BASE = '\/([^']+)'/.exec(client)?.[1]
  if (!clientBase) throw new Error('could not read ROUTE_BASE from the client half')
  if (hostBase !== clientBase) throw new Error(`host route base /${hostBase} != client route base /${clientBase}`)
  for (const route of ['/state', '/config', '/media', '/pick']) {
    if (!host.includes(`${'${ROUTE_BASE}'}${route}`)) throw new Error(`host is missing route ${route}`)
  }
  // The Connection service owns the sole `/api` route and answers 401 for anything under it
  // before the webserver's route table is consulted, so a plugin route must never live there.
  if (hostBase.startsWith('api/')) throw new Error('plugin routes must not live under /api — the Connection service owns that prefix')
})

// 7. The published file list must cover everything read at runtime.
check('files[] covers runtime reads', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const entry of ['index.js', 'client.js', 'assets', 'cordis.patch.yml', 'icon.svg', 'locale']) {
    if (!pkg.files.includes(entry)) throw new Error(`files[] is missing ${entry}`)
  }
})

// 10. Every theme token the client half references must be one the Theme service actually
//     declares. A misspelled token does not error — it silently falls through to the
//     hardcoded fallback, so the page looks fine in one appearance and ignores the other.
//     `--dsh-color-*` was exactly that mistake: none of those names exist.
const KNOWN_TOKENS = {
  light: ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary', '--dsw-specific-sidebar-fill'],
  dark: ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary', '--dsw-specific-sidebar-fill'],
}

check('client references only declared theme tokens', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  // Drop comments first: the explanatory note about the old names must not fail the check.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const declared = new Set([...KNOWN_TOKENS.light, ...KNOWN_TOKENS.dark])
  const used = new Set()
  for (const match of code.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(match[1])
  const unknown = [...used].filter((name) => !declared.has(name))
  if (unknown.length) {
    throw new Error(`undeclared theme token(s): ${unknown.join(', ')} — these never resolve, so every fallback wins`)
  }
  // The known list is what makes the check meaningful; keep it honest by using tokens.
  if (used.size === 0) throw new Error('no theme tokens found — did the client stop using them?')
  // The Theme service requires light AND dark for each; assert we did not invent one.
  for (const name of used) {
    if (!KNOWN_TOKENS.light.includes(name) || !KNOWN_TOKENS.dark.includes(name)) {
      throw new Error(`${name} is not declared for both appearances`)
    }
  }
})

// 10. A text or number input must not save on every keystroke: each save re-adopts the config
//     from the Host, which resets the input under the caret so the user can only ever type one
//     character. A checkbox or a select carries its whole value in one event, so committing
//     straight from its `onChange` is correct and stays allowed.
check('no half-typed input commits on every keystroke', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const offenders = []
  for (const match of source.matchAll(/type:\s*'(number|text)'/g)) {
    // Look ahead to this element's handler block, not the whole file.
    const window = source.slice(match.index, match.index + 900)
    const handler = /onChange:\s*\([^)]*\)\s*=>\s*\{?([^\n]*)/.exec(window)
    if (handler && /\b(commit|save)\s*\(/.test(handler[1])) {
      offenders.push(`${match[1]} input at offset ${match.index}: ${handler[1].trim()}`)
    }
  }
  if (offenders.length) {
    throw new Error(`a keystroke-driven input commits directly: ${offenders.join(' | ')} — keep a local draft and commit on blur/Enter`)
  }
  // Without these the guard above would pass vacuously.
  if (!/function NumberField/.test(source)) throw new Error('NumberField is missing')
  if (!/onBlur:\s*commitDraft/.test(source)) throw new Error('NumberField does not commit on blur')
  if (!/onChange:\s*\(event\)\s*=>\s*setDraft\(/.test(source)) throw new Error('NumberField does not keep a local draft')
})

// 11. The preview button must be able to play at any time, not only while a startup splash
//     happens to be alive. A startup layer is removed from the DOM once it finishes, so a
//     preview that renders into it does nothing at all after boot — the failure this guards.
check('the preview builds its own layer', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  if (!/function startSplashPreview/.test(source)) throw new Error('startSplashPreview is missing')
  if (!/openLayer\(\{\s*preview:\s*true/.test(source)) {
    throw new Error('startSplashPreview must open a fresh layer, not reuse the startup one')
  }
  // It must report whether it started, so the page can explain a refusal instead of no-op.
  if (!/return false/.test(source.slice(source.indexOf('function startSplashPreview')))) {
    throw new Error('startSplashPreview must return whether a preview started')
  }
  // A preview must not tear itself down on `ended`, or it vanishes the instant it plays.
  if (!/if \(preview\) return\b/.test(source)) {
    throw new Error('a preview must linger after playback instead of exiting like the splash')
  }
  // Replacing a live preview is what makes the button repeatable.
  if (!/previous\.dispose\(\)/.test(source)) throw new Error('a second preview must replace the first')
})

// 12. A preview must terminate on its own even when the reveal never fires, and an image must
//     have its `load` listener attached before `src`.
//
//     Both halves of the same bug: the teardown used to be armed only inside `reveal()`, and
//     `reveal()` was reached only through a `load` listener attached after `src` was set. A
//     cached asset can complete synchronously, so `load` fired into nothing and the preview
//     stayed on screen forever.
check('a preview cannot be stranded by a missed reveal', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')

  // The teardown must be armed by present() itself, at its top level — not from inside a
  // reveal path, because the reveal is the thing that may never happen. Searching the whole
  // body would also match the nested helpers, so the check is positional: the arming call
  // must sit at the same indent as present()'s own statements, after the element is created.
  const presentStart = source.indexOf('const present = (')
  const presentEnd = source.indexOf("      /** Lift the cover", presentStart)
  if (presentStart < 0 || presentEnd < 0) throw new Error('could not locate present()')
  const present = source.slice(presentStart, presentEnd)
  if (!/\n {8}schedulePreviewTeardown\(\)\n/.test(present)) {
    throw new Error('present() must arm the preview teardown at its own level, not only from a reveal path')
  }
  if (!/if \(img\.complete\) startImage\(\)\n {8}schedulePreviewTeardown\(\)/.test(present)) {
    throw new Error('the teardown must be armed unconditionally, after the cached-image reveal')
  }
  if (/schedulePreviewTeardown\(\)/.test(source.slice(source.indexOf('function reveal()'), source.indexOf('function armVideo')))) {
    throw new Error('reveal() must not arm the teardown; that would hide a missing top-level arming')
  }
  // Arming twice must be impossible, or a re-present would stack teardowns.
  if (!/if \(!preview \|\| teardownArmed/.test(source)) {
    throw new Error('the preview teardown must be idempotent')
  }
  // A preview must not depend on the startup playback deadline, which is never armed for it.
  const preview = source.slice(source.indexOf('function startSplashPreview'), source.indexOf('// ------', source.indexOf('function startSplashPreview')))
  if (/armPlaybackDeadline/.test(preview)) {
    throw new Error('the preview must own its bound, not borrow the startup deadline')
  }

  // Every image the layer creates must be revealed through a `load` path, or the cover never
  // lifts. Guarding the `img` variable name keeps the ordering rule meaningful.
  if (!/const img = document\.createElement\('img'\)/.test(source)) {
    throw new Error('the layer must bind the image element to `img`, which the ordering rule below checks')
  }
  if (!/img\.addEventListener\('load'/.test(source)) {
    throw new Error("the image path must attach a 'load' listener on the image element")
  }
  // Every `img.src = ` must have a `load` listener somewhere before it. A positional rule on
  // purpose: the earlier version used a fixed lookback window, which was too short to see a
  // listener attached one function call up, so it failed for the wrong reason.
  const loadListener = source.indexOf("addEventListener('load'")
  for (const match of source.matchAll(/img\.src\s*=/g)) {
    if (loadListener < 0 || loadListener > match.index) {
      throw new Error(`img.src is assigned at offset ${match.index} before any 'load' listener — a cached load would be missed`)
    }
  }
})

console.log(notes.join('\n'))
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nall checks passed')
