import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateNormalizedUnitPrice,
  isSpecialTransaction,
  normalizeAddress,
  normalizeBuildingType,
  parseFloor,
  parseRocDate,
  sqmToPing,
  stableId,
  twd97ToWgs84,
  withRetry,
} from './core.mjs'

test('民國日期正規化並拒絕無效日期', () => {
  assert.equal(parseRocDate('1150601'), '2026-06-01')
  assert.equal(parseRocDate('950705'), '2006-07-05')
  assert.equal(parseRocDate('1151332'), null)
})

test('坪數與車位拆價', () => {
  assert.equal(sqmToPing(33.05785), 10)
  assert.equal(calculateNormalizedUnitPrice(20_000_000, 40, 2_000_000, 10), 600_000)
})

test('建物型態與樓層正規化', () => {
  assert.equal(normalizeBuildingType('住宅大樓(11層含以上有電梯)'), 'highrise')
  assert.equal(normalizeBuildingType('透天厝'), null)
  assert.equal(parseFloor('二十五層'), 25)
  assert.equal(parseFloor('一層，二層'), 0)
})

test('門牌正規化只保留可精確比對的門牌部分', () => {
  assert.equal(
    normalizeAddress('新北市林口區中山路５６９號九樓', 'new-taipei', '林口區'),
    '中山路569號',
  )
  assert.equal(
    normalizeAddress('臺北市大安區和平東路二段 10-2 號', 'taipei', '大安區'),
    '和平東路二段10之2號',
  )
})

test('TWD97 轉 WGS84 位於合理範圍', () => {
  const coordinate = twd97ToWgs84(306948, 2770968)
  assert.ok(coordinate)
  assert.ok(coordinate.latitude > 24.9 && coordinate.latitude < 25.2)
  assert.ok(coordinate.longitude > 121.4 && coordinate.longitude < 121.8)
})

test('特殊交易與穩定 ID', () => {
  assert.equal(isSpecialTransaction('親友間交易'), true)
  assert.equal(isSpecialTransaction(''), false)
  assert.equal(stableId(['A', 1]), stableId(['A', 1]))
  assert.notEqual(stableId(['A', 1]), stableId(['A', 2]))
})

test('來源失敗最多重試三次', async () => {
  let attempts = 0
  await assert.rejects(() => withRetry('test', async () => {
    attempts += 1
    throw new Error('failed')
  }, { error() {} }))
  assert.equal(attempts, 3)
})
