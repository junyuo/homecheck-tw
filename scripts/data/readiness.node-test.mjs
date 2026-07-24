import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildReadinessManifest,
  readinessSource,
  validateReadinessManifest,
  writeReadinessManifest,
} from './readiness.mjs'

const rates = { taipei: 1, 'new-taipei': 0.8, overall: 0.9 }

test('市場 blocked 候選只輸出聚合白名單欄位', () => {
  const report = readinessSource('market', {
    adapterVersion: 'market-v2',
    generatedAt: '2026-07-24T00:00:00.000Z',
    status: 'blocked',
    blockedReason: '新北定位率未達 95%',
    matchingRates: rates,
    sourceSha256: 'secret',
    qualityReport: {
      excluded: { unmatchedAddress: 7 },
      locationMethods: { 'address-index-exact': 67 },
      unmatched: [{ name: '不得公開', addressSha256: 'secret' }],
    },
  })
  assert.deepEqual(Object.keys(report), [
    'id',
    'status',
    'checkedAt',
    'adapterVersion',
    'matchingRates',
    'excluded',
    'locationMethods',
    'blockedReason',
  ])
  assert.equal(JSON.stringify(report).includes('不得公開'), false)
  assert.equal(JSON.stringify(report).includes('secret'), false)
})

test('公園 ready 與 blocked 狀態均使用相同 schema', () => {
  const report = readinessSource('park', {
    adapterVersion: 'community-v2',
    generatedAt: '2026-07-24T00:00:00.000Z',
    readiness: {
      park: {
        status: 'ready',
        matchingRates: { taipei: 1, 'new-taipei': 0.96, overall: 0.96 },
        qualityReport: {
          excluded: {},
          locationMethods: { 'address-index-exact': 10 },
        },
      },
    },
  })
  assert.equal(report.status, 'ready')
  assert.equal(report.blockedReason, null)
  assert.doesNotThrow(() => validateReadinessManifest(buildReadinessManifest(
    null,
    [report],
    '2026-07-24T00:00:00.000Z',
  )))
})

test('readiness 拒絕隱私欄位與無效計數', () => {
  const manifest = buildReadinessManifest(null, [readinessSource('market', {
    adapterVersion: 'market-v2',
    generatedAt: '2026-07-24T00:00:00.000Z',
    status: 'blocked',
    blockedReason: 'blocked',
    matchingRates: rates,
    qualityReport: { excluded: {}, locationMethods: {} },
  })], '2026-07-24T00:00:00.000Z')
  manifest.sources.market.address = '不得出現'
  assert.throws(() => validateReadinessManifest(manifest), /欄位無效/)
  delete manifest.sources.market.address
  manifest.sources.market.excluded.bad = -1
  assert.throws(() => validateReadinessManifest(manifest), /無效計數/)
})

test('寫入 readiness 不修改同目錄的 manifest 與 GeoJSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homecheck-readiness-'))
  const manifestFile = join(directory, 'manifest.json')
  const geoJsonFile = join(directory, 'market.geojson')
  const readinessFile = join(directory, 'readiness.json')
  await writeFile(manifestFile, '{"dataVersion":"last-good"}\n')
  await writeFile(geoJsonFile, '{"type":"FeatureCollection","features":[]}\n')
  const before = await Promise.all([
    readFile(manifestFile, 'utf8'),
    readFile(geoJsonFile, 'utf8'),
  ])
  const report = readinessSource('market', {
    adapterVersion: 'market-v2',
    generatedAt: '2026-07-24T00:00:00.000Z',
    status: 'blocked',
    blockedReason: 'blocked',
    matchingRates: rates,
    qualityReport: { excluded: {}, locationMethods: {} },
  })
  await writeReadinessManifest(
    readinessFile,
    buildReadinessManifest(null, [report], report.checkedAt),
  )
  const after = await Promise.all([
    readFile(manifestFile, 'utf8'),
    readFile(geoJsonFile, 'utf8'),
  ])
  assert.deepEqual(after, before)
  assert.equal(JSON.parse(await readFile(readinessFile, 'utf8')).sources.market.status, 'blocked')
})
