import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePriceAudit, evaluateRailAudit, evaluateRiskAudit } from './audit.mjs'
import { selectAuditCandidates } from './price.mjs'

const matchedFields = {
  date: true,
  totalPrice: true,
  areaSquareMeters: true,
  buildingType: true,
  floor: true,
  parkingPrice: true,
  parkingAreaSquareMeters: true,
}

test('價格主要與備援樣本穩定且主要樣本涵蓋三種建物型態', () => {
  const candidates = ['apartment', 'mansion', 'highrise'].flatMap((buildingType, typeIndex) =>
    Array.from({ length: 15 }, (_, index) => ({
      id: `${String(index).padStart(2, '0')}-${typeIndex}`,
      buildingType,
    })))
  const first = selectAuditCandidates(candidates)
  const second = selectAuditCandidates([...candidates].reverse())
  assert.deepEqual(first, second)
  assert.equal(first.primary.length, 10)
  assert.equal(first.reserve.length, 20)
  assert.equal(new Set(first.primary.map((item) => item.buildingType)).size, 3)
  assert.equal(new Set([...first.primary, ...first.reserve].map((item) => item.id)).size, 30)
})

test('價格驗收排除 inconclusive 並要求每市十筆與三種型態', () => {
  const samples = ['taipei', 'new-taipei'].flatMap((city) =>
    Array.from({ length: 10 }, (_, index) => ({
      id: `${city}-${index}`,
      city,
      buildingType: ['apartment', 'mansion', 'highrise'][index % 3],
      result: 'matched',
      fields: matchedFields,
    })))
  samples.push({ id: 'timeout', city: 'taipei', result: 'inconclusive' })
  const result = evaluatePriceAudit({
    status: 'passed',
    adapterVersion: 'price-v1',
    sourceSha256: 'source',
    datasetSha256: 'dataset',
    samples,
  }, {
    adapterVersion: 'price-v1',
    sourceSha256: 'source',
    datasetSha256: 'dataset',
  })
  assert.equal(result.passed, true)
  assert.equal(result.sampleCount, 20)
  assert.equal(result.requiredSampleCount, 20)
})

test('價格 mismatch 或 adapter 版本改變時阻擋發布', () => {
  const samples = ['taipei', 'new-taipei'].flatMap((city) =>
    Array.from({ length: 10 }, (_, index) => ({
      id: `${city}-${index}`,
      city,
      buildingType: ['apartment', 'mansion', 'highrise'][index % 3],
      result: index === 0 && city === 'taipei' ? 'mismatch' : 'matched',
      fields: matchedFields,
    })))
  assert.equal(evaluatePriceAudit({
    status: 'passed',
    adapterVersion: 'price-v1',
    samples,
  }, {
    adapterVersion: 'price-v2',
  }).passed, false)
})

test('日常來源與資料雜湊更新不會讓人工驗收失效', () => {
  const samples = ['taipei', 'new-taipei'].flatMap((city) =>
    Array.from({ length: 10 }, (_, index) => ({
      id: `${city}-${index}`,
      city,
      buildingType: ['apartment', 'mansion', 'highrise'][index % 3],
      result: 'matched',
      fields: matchedFields,
    })))
  assert.equal(evaluatePriceAudit({
    status: 'passed',
    adapterVersion: 'price-v1',
    sourceSha256: 'old-source',
    datasetSha256: 'old-dataset',
    samples,
  }, {
    adapterVersion: 'price-v1',
    sourceSha256: 'new-source',
    datasetSha256: 'new-dataset',
  }).passed, true)
})

test('災害驗收要求每市五點與指定案例覆蓋', () => {
  const samples = ['taipei', 'new-taipei'].flatMap((city) => [
    { id: `${city}-r1`, source: 'flood', city, caseType: 'red', expectedCategory: '0.5-1.0', result: 'matched' },
    { id: `${city}-r2`, source: 'flood', city, caseType: 'red', expectedCategory: '1.0-2.0', result: 'matched' },
    { id: `${city}-y1`, source: 'flood', city, caseType: 'yellow', expectedCategory: '0.3-0.5', result: 'matched' },
    { id: `${city}-y2`, source: 'flood', city, caseType: 'yellow', expectedCategory: '0.3-0.5', result: 'matched' },
    { id: `${city}-u`, source: 'flood', city, caseType: 'unknown', expectedCategory: '未確認覆蓋', result: 'matched' },
  ])
  samples.forEach((sample, index) => Object.assign(sample, {
    observedCategory: sample.expectedCategory,
    longitude: Number((121.5 + index / 10000).toFixed(5)),
    latitude: Number((25 + index / 10000).toFixed(5)),
  }))
  const result = evaluateRiskAudit({
    status: 'passed',
    adapterVersion: 'risks-v1',
    fingerprints: { flood: { sourceSha256: 'source', datasetSha256: 'dataset' } },
    samples,
  }, 'flood', {
    adapterVersion: 'risks-v1',
    sourceSha256: 'source',
    datasetSha256: 'dataset',
  })
  assert.equal(result.passed, true)
  assert.equal(result.sampleCount, 10)
})

test('臺鐵驗收要求臺北四站、新北五站與四個欄位一致', () => {
  const fields = { name: true, address: true, district: true, gps: true }
  const samples = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `taipei-${index}`, city: 'taipei', result: 'matched', fields,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `new-taipei-${index}`, city: 'new-taipei', result: 'matched', fields,
    })),
  ]
  assert.equal(evaluateRailAudit({
    status: 'passed',
    adapterVersion: 'rail-v1',
    sourceSha256: 'source',
    datasetSha256: 'dataset',
    samples,
  }, {
    adapterVersion: 'rail-v1',
    sourceSha256: 'source',
    datasetSha256: 'dataset',
  }).passed, true)
})
