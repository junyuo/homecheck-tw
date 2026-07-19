import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ALL_DISTRICTS } from './constants.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const data = resolve(root, 'public', 'data')

test('production manifest 涵蓋雙北 41 區且不引用 Demo', async () => {
  const manifest = JSON.parse(await readFile(resolve(data, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, '2.0.0')
  assert.equal(manifest.mode, 'production')
  assert.equal(manifest.coverage.districts.length, 41)
  assert.deepEqual(
    new Set(manifest.coverage.districts),
    new Set(ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`)),
  )
  for (const source of Object.values(manifest.sources)) {
    for (const file of source.files) {
      assert.doesNotMatch(file, /demo/i)
      await access(resolve(data, file))
      assert.ok((await stat(resolve(data, file))).size <= 5 * 1024 * 1024)
    }
  }
})

test('正式價格符合自動品質門檻', async () => {
  const manifest = JSON.parse(await readFile(resolve(data, 'manifest.json'), 'utf8'))
  const price = manifest.sources['actual-price']
  assert.equal(price.status, 'official')
  assert.ok(price.matchingRate >= 0.95)
  assert.ok(price.recordCount > 0)
  assert.equal(new Set(price.coverage.districts).size, 41)
})
