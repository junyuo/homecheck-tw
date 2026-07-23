import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { addressKey } from './address-index.mjs'
import {
  MARKET_BLOCKED_REASON,
  classifyTaipeiPublicMarkets,
  decodeMarketCsv,
  normalizeMarketName,
  parseMarketCsv,
  parseNewTaipeiMarkets,
  parseTaipeiMarkets,
  updateOfficialMarkets,
} from './market.mjs'

const coordinate = { longitude: 121.5434, latitude: 25.0269 }

function boundary(city, district, center = coordinate) {
  const [longitude, latitude] = [center.longitude, center.latitude]
  return new Map([[`${city}/${district}`, {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [longitude - 0.01, latitude - 0.01],
          [longitude + 0.01, latitude - 0.01],
          [longitude + 0.01, latitude + 0.01],
          [longitude - 0.01, latitude + 0.01],
          [longitude - 0.01, latitude - 0.01],
        ]],
      },
    }],
  }]])
}

test('Big5 解碼與 quoted multiline CSV 不拆壞欄位', () => {
  assert.equal(decodeMarketCsv(
    new Uint8Array([0xa5, 0xab, 0xb3, 0xf5]),
    'big5',
  ), '市場')
  const rows = parseMarketCsv(
    '行政區,市場名稱,備註\r\n大安區,忠孝市場,"71年開業\r\n都更程序中"\r\n',
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].備註, '71年開業\r\n都更程序中')
})

test('公有市場名稱正規化、同市場攤位合併與生鮮門檻', () => {
  const csv = [
    '行政區,市場名稱,蔬菜（數量）,青果（數量）,獸肉（數量）,漁產（數量）,家禽（數量）,糧食（數量）,百貨（數量）',
    '大同區,永樂市場,0,0,0,0,0,0,10',
    '大同區,永樂市場(1樓),3,0,0,0,0,0,0',
    '中正區,光華數位新天地(110),0,0,0,0,0,0,377',
  ].join('\n')
  const classified = classifyTaipeiPublicMarkets(csv)
  assert.equal(normalizeMarketName('臺北市公有永樂市場(1樓)'), '永樂市場')
  assert.equal(classified.get('永樂市場').rowCount, 2)
  assert.equal(classified.get('永樂市場').freshStallCount, 3)
  assert.equal(classified.get('光華數位新天地').freshStallCount, 0)
})

test('臺北公有與民有市場使用穩定分類且不公開地址', () => {
  const publicCoordinate = { longitude: 121.52, latitude: 25.05 }
  const index = new Map([
    [addressKey('大安區', '和平東路二段1號'), coordinate],
    [addressKey('中山區', '長安西路3號'), publicCoordinate],
  ])
  const parsed = parseTaipeiMarkets({
    publicCsv: [
      'seqno,stitle,xAddress,GTag_longitude,GTag_latitude',
      '1,臺北市公有中山市場,臺北市中山區長安西路3號,121.52,25.05',
    ].join('\n'),
    publicStallCsv: [
      '市場名稱,蔬菜（數量）,青果（數量）,獸肉（數量）,漁產（數量）,家禽（數量）,糧食（數量）',
      '中山市場,1,0,0,0,0,0',
    ].join('\n'),
    privateCsv: [
      '行政區,市場名稱,市場地址,備註',
      '大安區,測試民有市場,臺北市大安區和平東路二段1號,"開業\n都更程序中"',
    ].join('\n'),
    addressIndex: index,
    sourceUpdatedAt: '2026-07-23T00:00:00.000Z',
  })
  assert.equal(parsed.length, 2)
  assert.deepEqual(
    parsed.map((item) => item.feature.properties.marketOwnership),
    ['public', 'private'],
  )
  assert.deepEqual(
    parsed.map((item) => item.classificationMethod),
    ['fresh-stall-count', 'official-private-registry'],
  )
  assert.equal(parsed[0].feature.properties.facilityType, 'traditional-market')
  assert.equal('address' in parsed[0].feature.properties, false)
  assert.notEqual(parsed[0].feature.properties.id, parsed[1].feature.properties.id)
})

test('無生鮮或糧食攤位的特殊商場不列入定位率分母', () => {
  const parsed = parseTaipeiMarkets({
    publicCsv: [
      'seqno,stitle,xAddress,GTag_longitude,GTag_latitude',
      '1,光華數位新天地,臺北市中正區市民大道三段8號,121.53,25.04',
    ].join('\n'),
    publicStallCsv: [
      '市場名稱,蔬菜（數量）,青果（數量）,獸肉（數量）,漁產（數量）,家禽（數量）,糧食（數量）,百貨（數量）',
      '光華數位新天地(110),0,0,0,0,0,0,377',
    ].join('\n'),
    privateCsv: '行政區,市場名稱,市場地址\n',
    addressIndex: new Map(),
    sourceUpdatedAt: '2026-07-23T00:00:00.000Z',
  })
  assert.equal(parsed[0].excluded, 'noFreshFoodStalls')
  assert.equal(parsed[0].classificationEligible, false)
})

test('臺北公有門牌未匹配時使用行政區內官方座標備援', () => {
  const parsed = parseTaipeiMarkets({
    publicCsv: [
      'seqno,stitle,xAddress,GTag_longitude,GTag_latitude',
      '1,臺北市公有成功市場（臨時攤棚）,臺北市大安區四維路192巷,121.5434,25.0269',
    ].join('\n'),
    publicStallCsv: [
      '市場名稱,蔬菜（數量）,青果（數量）,獸肉（數量）,漁產（數量）,家禽（數量）,糧食（數量）',
      '成功中繼市場,1,0,0,0,0,0',
    ].join('\n'),
    privateCsv: '行政區,市場名稱,市場地址\n',
    addressIndex: new Map(),
    boundaries: boundary('taipei', 'daan'),
    sourceUpdatedAt: '2026-07-23T00:00:00.000Z',
  })
  assert.equal(parsed[0].district, 'daan')
  assert.equal(parsed[0].evidence.locationMethod, 'official-coordinate-fallback')
})

test('臺北公有官方座標與門牌座標相差超過 150 公尺時阻擋', () => {
  const index = new Map([[
    addressKey('大安區', '和平東路二段1號'),
    { longitude: 121.55, latitude: 25.04 },
  ]])
  assert.throws(() => parseTaipeiMarkets({
    publicCsv: [
      'seqno,stitle,xAddress,GTag_longitude,GTag_latitude',
      '1,臺北市公有測試市場,臺北市大安區和平東路二段1號,121.5434,25.0269',
    ].join('\n'),
    publicStallCsv: [
      '市場名稱,蔬菜（數量）,青果（數量）,獸肉（數量）,漁產（數量）,家禽（數量）,糧食（數量）',
      '測試市場,1,0,0,0,0,0',
    ].join('\n'),
    privateCsv: '行政區,市場名稱,市場地址\n',
    addressIndex: index,
    boundaries: boundary('taipei', 'daan'),
    sourceUpdatedAt: '2026-07-23T00:00:00.000Z',
  }), /超過 150 公尺/)
})

test('民有市場缺行政區與多地址時只接受跨區唯一門牌匹配', () => {
  const index = new Map([[
    addressKey('松山區', '新中街7號'),
    { longitude: 121.56, latitude: 25.06 },
  ]])
  const parsed = parseTaipeiMarkets({
    publicCsv: 'seqno,stitle,xAddress,GTag_longitude,GTag_latitude\n',
    publicStallCsv: '市場名稱,蔬菜（數量）\n',
    privateCsv: '行政區,市場名稱,市場地址\n,東社市場,"新中街7號、9號\n新中街13之2號(通訊地址)"\n',
    addressIndex: index,
    sourceUpdatedAt: '2026-07-23T00:00:00.000Z',
  })
  assert.equal(parsed[0].district, 'songshan')
  assert.equal(parsed[0].evidence.locationMethod, 'address-index-exact')
})

test('新北只納入傳統市場並排除超市、批發與夜市', () => {
  const index = new Map([[addressKey('板橋區', '文化路一段1號'), coordinate]])
  const parsed = parseNewTaipeiMarkets([
    'item,name,county,town,address,types',
    '1,板橋市場,新北市,板橋區,新北市板橋區文化路一段1號,早市',
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

test('新北市場地址可正規化重複行政區文字', () => {
  const index = new Map([[addressKey('林口區', '麗園一街35號'), coordinate]])
  const [market] = parseNewTaipeiMarkets([
    'item,name,county,town,address,types',
    '1,東勢公有市場,新北市,林口區,新北市林口區林口區麗園一街35號,早市',
  ].join('\n'), index, '2026-07-23T00:00:00.000Z')
  assert.equal(market.feature.properties.name, '東勢公有市場')
})

test('官方市場來源缺少時保留阻擋證據且不輸出資料', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'homecheck-market-'))
  const result = await updateOfficialMarkets({
    output: cache,
    cache,
    sourceUrls: {
      taipeiPublic: null,
      taipeiPublicStalls: null,
      taipeiPrivate: null,
      newTaipei: 'unused',
    },
  })
  assert.deepEqual(result, {
    id: 'market',
    status: 'failed',
    error: MARKET_BLOCKED_REASON,
  })
  const candidates = JSON.parse(await readFile(
    join(cache, 'market-audit-candidates.json'),
    'utf8',
  ))
  assert.equal(candidates.status, 'blocked')
  assert.equal(candidates.blockedReason, MARKET_BLOCKED_REASON)
  assert.deepEqual(candidates.samples, { taipei: [], 'new-taipei': [] })
})
