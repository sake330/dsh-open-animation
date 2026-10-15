// Check the README against the code, so the user-facing document cannot drift silently.
// Usage: node tools/check-docs.mjs
//
// The README is deliberately small: install, use, the config table, formats, troubleshooting.
// Engineering notes (the HTTP surface, the trust fence, the Cordis context trap, the test
// suites) live in code comments and tools/ instead — so this file only asserts the claims a
// user actually reads, plus the code invariants that no longer have a document to live in.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const host = readFileSync(join(root, 'index.js'), 'utf8')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const failures = []
const notes = []

// 1. Every config default in the code must appear in the README table with the same value.
const start = host.indexOf('const CONFIG_DEFAULTS = {')
const defaults = {}
for (const match of host.slice(start, host.indexOf('\n}', start)).matchAll(/^\s{2}(\w+):\s*(.+?),?$/gm)) {
  defaults[match[1]] = match[2].replace(/,$/, '').replace(/^'(.*)'$/, '$1')
}

const documented = new Map()
for (const line of readme.split('\n')) {
  const row = /^\|\s*`([a-zA-Z]+)`\s*\|\s*(.+?)\s*\|/.exec(line)
  if (!row) continue
  // Cells wrap the default in backticks and sometimes quotes; normalize both away so that
  // the README's `''` and the code's "" compare equal.
  const raw = row[2].trim().replace(/^`(.*)`$/, '$1').trim()
  documented.set(row[1], raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'))
}

for (const [key, value] of Object.entries(defaults)) {
  if (!documented.has(key)) failures.push(`README is missing config field \`${key}\``)
  else if (documented.get(key) !== value) {
    failures.push(`\`${key}\` documented as "${documented.get(key)}" but the code default is "${value}"`)
  }
}
for (const key of documented.keys()) {
  if (!(key in defaults)) failures.push(`README documents \`${key}\`, which is not a config field`)
}
notes.push(`  ok   README documents all ${Object.keys(defaults).length} config fields with matching defaults`)

// 2. Every documented setting must be reachable from the settings page or the patch file.
for (const key of Object.keys(defaults)) {
  if (!host.includes(`${key}:`) && !client.includes(key)) {
    failures.push(`\`${key}\` exists in neither half`)
  }
}

// 3. Route names must be registered by the host. The README is user-facing and no longer
//    documents the HTTP surface, so this is a code invariant rather than a doc claim — it
//    lives here because this file already loads both halves.
const routes = ['state', 'config', 'media', 'pick']
for (const route of routes) {
  if (!host.includes(`${'${ROUTE_BASE}'}/${route}`)) failures.push(`route \`${route}\` is not registered by the host`)
}
notes.push(`  ok   all ${routes.length} routes are registered by the host`)

// 4. The documented test commands must exist and be wired into `npm test`. The README no
//    longer lists them, so only the wiring is asserted.
const testScript = pkg.scripts?.test ?? ''
for (const file of ['verify.mjs', 'check-docs.mjs', 'smoke-context.mjs', 'smoke-host.mjs']) {
  if (!existsSync(join(root, 'tools', file))) failures.push(`tools/${file} does not exist`)
  if (!testScript.includes(file)) failures.push(`npm test does not run tools/${file}`)
}
notes.push('  ok   every test file exists and runs under `npm test`')

// 5. The README must still name the package, or a reader cannot tell what they installed.
if (!readme.includes(pkg.name)) failures.push(`README does not name the package ${pkg.name}`)
if (!pkg.scripts?.test) failures.push('package.json has no test script')

// 6. The README is deliberately minimal. If it grows past a screenful of engineering detail
//    again, that is a decision to make on purpose rather than by drift.
const lines = readme.split('\n').length
if (lines > 140) failures.push(`README has grown to ${lines} lines; it is meant to stay user-facing (see the header note)`)
else notes.push(`  ok   README stays minimal (${lines} lines)`)

console.log(notes.join('\n'))
if (failures.length) {
  console.error(`\n${failures.length} doc/code mismatch(es):\n${failures.map((f) => `  FAIL ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('\nREADME matches the code')
