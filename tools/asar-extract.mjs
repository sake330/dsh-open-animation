// Extract files from an Electron ASAR archive by path prefix.
//
// Useful when a DSH question can only be answered by the packaged application — the shipped
// `app.asar` is the source of truth for behaviour no README documents. Point it at the file
// and one or more path prefixes; it copies each match out so ordinary tools can read it.
//
// Usage:
//   node tools/asar-extract.mjs <archive> <outDir> <prefix...>
//
// Examples:
//   # The plugin-authoring skill DSH ships, including its scaffold templates.
//   node tools/asar-extract.mjs "D:\DSH\resources\app.asar" ./out \
//     "/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/"
//
//   # A list of every path in the archive, for finding the prefix you want first.
//   node tools/asar-extract.mjs "D:\DSH\resources\app.asar" ./out /dsh/node_modules/@deepseek-ai/dsh-host-webserver/
//
// Notes:
//   - Reads the header with positioned reads, so multi-gigabyte archives work and nothing
//     is loaded whole. (`readFileSync` on a >4 GB file yields a BigInt-backed buffer that
//     breaks the usual `readUInt32LE` call.)
//   - Extracted files are the packaged application's own code. Read them to answer a
//     question, and do not commit or redistribute them.
import { openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [archive, outDir, ...prefixes] = process.argv.slice(2)
if (!archive || !outDir || prefixes.length === 0) {
  console.error('usage: node tools/asar-extract.mjs <archive> <outDir> <prefix...>')
  process.exit(2)
}

const fd = openSync(archive, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const jsonSize = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonSize)
readSync(fd, jsonBuf, 0, jsonSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const contentStart = 16 + jsonSize

const wanted = []
function walk(node, path) {
  const entries = node.files ?? {}
  for (const name of Object.keys(entries)) {
    const child = entries[name]
    const childPath = `${path}/${name}`
    if (child.files) walk(child, childPath)
    else if (prefixes.some((prefix) => childPath.startsWith(prefix))) {
      wanted.push({ path: childPath, offset: Number(child.offset), size: Number(child.size) })
    }
  }
}
walk(header, '')

// Copy in chunks so no single file has to fit in one buffer.
const CHUNK = 4 * 1024 * 1024
let total = 0
for (const file of wanted) {
  const target = join(outDir, file.path.replace(/^[/\\]/, ''))
  mkdirSync(dirname(target), { recursive: true })
  const chunks = []
  let remaining = file.size
  let position = contentStart + file.offset
  while (remaining > 0) {
    const size = Math.min(CHUNK, remaining)
    const buf = Buffer.allocUnsafe(size)
    readSync(fd, buf, 0, size, position)
    chunks.push(buf)
    position += size
    remaining -= size
  }
  writeFileSync(target, Buffer.concat(chunks, file.size))
  total += file.size
  console.log(`  ${file.path} (${file.size}B)`)
}
closeSync(fd)
console.log(`extracted ${wanted.length} file(s), ${(total / 1024).toFixed(0)} KiB -> ${outDir}`)
