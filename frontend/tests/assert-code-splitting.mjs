import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const assetsDir = join(process.cwd(), 'dist', 'assets')
const jsChunks = readdirSync(assetsDir).filter((file) => file.endsWith('.js'))

assert.ok(
  jsChunks.length > 1,
  `Expected more than one JS chunk in dist/assets, got ${jsChunks.length}: ${jsChunks.join(', ')}`,
)

console.log(`JS chunk count: ${jsChunks.length}`)
