import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { addressKey } from './address-index.mjs'
import {
  MARKET_BLOCKED_REASON,
  parseNewTaipeiMarkets,
  parseTaipeiMarkets,
  updateOfficialMarkets,
} from './market.mjs'

const coordinate = { longitude: 121.5434, latitude: 25.0269 }

test('臺北公有與民有市場使用穩定分類且不公開地址', () => {
  const index = new Map([
    [addressKey('大安區', '和平東路二段1號'), coordinate],
    [addressKey('中山區', '長安西路3號'), { longitude: 121.52, latitude: 25.05 }],
  ])
  const parsed = parseTaipeiMarkets({
    publicCsv: '序號,行政區,市場名稱,市場地址\n1,中山區,中山市場,臺北市中山區長安西路3號\n',
    privateCsv: '行政區,市場名稱,市場地址\n大安區,測試民有市場,臺北市大安區和平東路二段1號\n',
    addressIndex: index,
    sourceUpdatedAt: '2026-07-23T00:00:00.000Z',
  })
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed.map((item) => item.feature.properties.marketOwnership), ['public', 'private'])
  assert.equal(parsed[0].feature.properties.facilityType, 'traditional-market')
  assert.equal('address' in parsed[0].feature.properties, false)
  assert.notEqual(parsed[0].feature.properties.id, parsed[1].feature.properties.id)
})

test('新北只納入傳統市場並排除超市、批發與夜市', () => {
  const index = new Map([[addressKey('板橋區', '文化路一段1號'), coordinate]])
  const parsed = parseNewTaipeiMarkets([
    'item,name,county,town,address,types',
    '1,板橋市場,新北市,板橋區,新北市板橋區文化路一段1號,公有市場',
    '2,板橋超市,新北市,板橋區,新北市板橋區文化路一段1號,超市',
    '3,板橋批發,新北市,板橋區,新北市板橋區文化路一段1號,批發市場',
    '4,板橋夜市,新北市,板橋區,新北市板橋區文化路一段1號,夜市',
  ].join('\n'), index, '2026-07-23T00:00:00.000Z')
  assert.equal(parsed[0].feature.properties.marketOwnership, 'public')
  assert.deepEqual(parsed.slice(1).map((item) => item.excluded), [
    'notTraditionalMarket',
    'notTraditionalMarket',
    'notTraditionalMarket',
  ])
})

test('門牌無法精確匹配時不產生市場點位', () => {
  const parsed = parseNewTaipeiMarkets(
    'item,name,town,address,types\n1,未知市場,板橋區,新北市板橋區未知路99號,公有市場\n',
    new Map(),
    '2026-07-23T00:00:00.000Z',
  )
  assert.equal(parsed[0].excluded, 'unmatchedAddress')
})

test('臺北公有市場現況來源缺少時保留阻擋證據且不輸出資料', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'homecheck-market-'))
  const result = await updateOfficialMarkets({
    output: cache,
    cache,
    dryRun: true,
    sourceUrls: { taipeiPublic: null, taipeiPrivate: null, newTaipei: 'unused' },
  })
  assert.deepEqual(result, { id: 'market', status: 'failed', error: MARKET_BLOCKED_REASON })
  const candidates = JSON.parse(await readFile(join(cache, 'market-audit-candidates.json'), 'utf8'))
  assert.equal(candidates.status, 'blocked')
  assert.equal(candidates.blockedReason, MARKET_BLOCKED_REASON)
  assert.deepEqual(candidates.samples, { taipei: [], 'new-taipei': [] })
})
