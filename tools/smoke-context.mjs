// Regression test: a Cordis Context is a proxy that THROWS on an undeclared property.
// This reproduces that behaviour so an accidental `ctx.someService` in the host half fails
// here instead of during activation in the harness, where it costs a restart to discover.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
const notes = []
const ok = (label, detail = '') => notes.push(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
const bad = (label, detail) => failures.push(`  FAIL ${label}: ${detail}`)

const home = mkdtempSync(join(tmpdir(), 'dsh-open-animation-ctx-'))
process.env.DSH_HOME = home

const mod = await import('../index.js')

/**
 * A stand-in for Cordis's Context: reads of declared members work, reads of anything else
 * throw, exactly as the real proxy does. Everything below is a member the host half is
 * entitled to.
 */
function makeStrictContext(declared) {
  const routes = new Map()
  const disposers = []
  const ctx = new Proxy(
    {
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
      logger: {
        info: () => {},
        warn: () => {},
      },
    },
    {
      get(target, property, receiver) {
        if (typeof property !== 'string') return Reflect.get(target, property, receiver)
        if (property in target) return Reflect.get(target, property, receiver)
        // This is the behaviour that broke activation: an undeclared read throws.
        throw new Error(`cannot get property "${property}" without inject at new apply`)
      },
      has: (target, property) => (typeof property === 'string' ? property in target : Reflect.has(target, property)),
    },
  )
  return { ctx, routes, disposers }
}

// 1. A clean apply against the strict proxy must not read any undeclared member.
{
  const { ctx, routes } = makeStrictContext()
  let threw = null
  try {
    mod.apply(ctx, {})
  } catch (error) {
    threw = error
  }
  // Assert the set of routes rather than a count, so adding one is a visible change here
  // instead of an unrelated failure to re-count.
  const expected = ['state', 'config', 'media', 'pick']
  const registered = [...routes.keys()].map((key) => key.split('/').pop()).sort()
  if (threw) bad('apply() against a strict Cordis context', threw.message)
  else if (registered.join(',') !== [...expected].sort().join(',')) {
    bad('apply() registers every route', `got ${registered.join(', ') || '(none)'}`)
  } else ok('apply() reads no undeclared Context member', `${registered.length} routes`)
}

// 2. The harness home must come from the environment, since it is not a Service.
{
  const { ctx } = makeStrictContext()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(home, 'elsewhere')
  let threw = null
  try {
    mod.apply(ctx, {})
  } catch (error) {
    threw = error
  }
  process.env.DSH_HOME = previous
  if (threw) bad('apply() honours $DSH_HOME', threw.message)
  else ok('apply() resolves the harness home without ctx')
}

// 3. A blank $DSH_HOME must fall back to ~/.dsh rather than resolving to the cwd.
{
  const { ctx } = makeStrictContext()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '   '
  let threw = null
  try {
    mod.apply(ctx, {})
  } catch (error) {
    threw = error
  }
  process.env.DSH_HOME = previous
  if (threw) bad('apply() tolerates a blank $DSH_HOME', threw.message)
  else ok('apply() tolerates a blank $DSH_HOME')
}

// 4. `apply` without the row's optional keys at all.
{
  const { ctx, routes } = makeStrictContext()
  let threw = null
  try {
    mod.apply(ctx, undefined)
  } catch (error) {
    threw = error
  }
  if (threw) bad('apply() with no row config', threw.message)
  else if (routes.size === 0) bad('apply() with no row config', 'no routes registered')
  else ok('apply() with no row config', `${routes.size} routes`)
}

// 5. trustedHosts is accepted and must not leak into the config the client receives.
{
  const { ctx, routes } = makeStrictContext()
  let threw = null
  try {
    mod.apply(ctx, { trustedHosts: ['harness.lan'], fit: 'contain' })
  } catch (error) {
    threw = error
  }
  if (threw) bad('apply() accepts trustedHosts', threw.message)
  else {
    const handler = routes.get('exact /dsh-open-animation/state')
    const payload = await new Promise((resolve) => {
      const req = { method: 'GET', url: '/dsh-open-animation/state', headers: { host: '127.0.0.1:1' } }
      const res = {
        writeHead() {
          return this
        },
        end(chunk) {
          resolve(JSON.parse(chunk.toString('utf8')))
        },
      }
      Promise.resolve(handler(req, res)).catch((error) => bad('state handler', error.message))
    })
    if ('trustedHosts' in payload.config) bad('trustedHosts stays out of the client config', JSON.stringify(payload.config))
    else if (payload.config.fit !== 'contain') bad('row config still applies', JSON.stringify(payload.config))
    else ok('trustedHosts is consumed by the host and not shipped to the client')
  }
}

// 6. Saving from the settings page must not write the host-only field into config.json, and
//    the row config must stay the authority for it afterwards.
{
  const { ctx, routes } = makeStrictContext()
  mod.apply(ctx, { trustedHosts: ['patch-only.lan'] })

  const configHandler = routes.get('exact /dsh-open-animation/config')
  await new Promise((resolve) => {
    const buf = Buffer.from(JSON.stringify({ fadeOutMs: 640 }))
    const req = { method: 'POST', url: '/dsh-open-animation/config', headers: { host: '127.0.0.1:1' } }
    req.on = (event, fn) => {
      if (event === 'data') fn(buf)
      if (event === 'end') fn()
      return req
    }
    const res = {
      writeHead() {
        return this
      },
      end() {
        resolve(true)
      },
    }
    Promise.resolve(configHandler(req, res)).catch((error) => bad('config handler', error.message))
  })

  let saved = null
  try {
    saved = JSON.parse(readFileSync(join(home, 'dsh-open-animation', 'config.json'), 'utf8'))
  } catch (error) {
    bad('config.json is readable after a save', error.message)
  }
  if (saved) {
    if ('trustedHosts' in saved) bad('trustedHosts is not persisted to config.json', JSON.stringify(saved.trustedHosts))
    else if (saved.fadeOutMs !== 640) bad('the save itself did not land', JSON.stringify(saved.fadeOutMs))
    else ok('a settings save persists the animation config without the host-only field')
  }

  const stateHandler = routes.get('exact /dsh-open-animation/state')
  const after = await new Promise((resolve) => {
    const req = { method: 'GET', url: '/dsh-open-animation/state', headers: { host: '127.0.0.1:1' } }
    const res = {
      writeHead() {
        return this
      },
      end(chunk) {
        resolve(JSON.parse(chunk.toString('utf8')))
      },
    }
    Promise.resolve(stateHandler(req, res)).catch((error) => bad('state handler', error.message))
  })
  if ('trustedHosts' in after.config) bad('trustedHosts hidden even after a save', JSON.stringify(after.config))
  else if (after.config.fadeOutMs !== 640) bad('the saved value is not effective', String(after.config.fadeOutMs))
  else ok('a save and the row config coexist without leaking the host-only field')
}

rmSync(home, { recursive: true, force: true })

console.log(notes.join('\n'))
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nstrict-context test passed')
