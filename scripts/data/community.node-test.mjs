import assert from 'node:assert/strict'
import test from 'node:test'
import { addressKey } from './address-index.mjs'
import {
  mergeSchoolCampuses,
  parseNewTaipeiSchoolLandmarks,
  parseNewTaipeiParks,
  parseSchools,
  parseTaipeiParks,
} from './community.mjs'

const coordinate = { longitude: 121.54, latitude: 25.04 }

function indexes() {
  return {
    taipei: {
      index: new Map([[addressKey('大安區', '和平東路二段1號'), coordinate]]),
    },
    'new-taipei': {
      index: new Map([[addressKey('板橋區', '文化路一段1號'), coordinate]]),
    },
  }
}

test('學校只選 114 學年度並合併同址附設部別', () => {
  const common = {
    '學年度': 114,
    '縣市名稱': '[00]臺北市',
    '地址': '[106]臺北市大安區和平東路二段1號',
  }
  const parsed = parseSchools({
    elementary: [
      { ...common, '代碼': 'E1', '學校名稱': '測試國小' },
      { ...common, '學年度': 113, '代碼': 'OLD', '學校名稱': '舊資料' },
    ],
    junior: [{ ...common, '代碼': 'J1', '學校名稱': '測試國中' }],
    senior: [],
    special: '縣市,學校,地址,電話,網址,傳真\n',
  }, indexes(), '2026-07-20T00:00:00.000Z')
  const merged = mergeSchoolCampuses(parsed)
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].feature.properties.schoolLevels, ['elementary', 'junior'])
  assert.deepEqual(merged[0].feature.properties.officialCodes, ['E1', 'J1'])
  assert.equal('address' in merged[0].feature.properties, false)
})

test('新北學校只以行政區與校名完全一致的官方地標補位', () => {
  const landmarks = parseNewTaipeiSchoolLandmarks([
    {
      objectid: 'landmark-1',
      行政區: '板橋區',
      地標類型: '國民小學',
      地標名稱: '新北市立測試國民小學',
      twd97_x: '297000',
      twd97_y: '2768000',
    },
  ])
  const parsed = parseSchools({
    elementary: [{
      學年度: 114,
      縣市名稱: '[01]新北市',
      地址: '[220]新北市板橋區未知路99號',
      代碼: 'NTPC-E1',
      學校名稱: '新北市立測試國民小學',
    }],
    junior: [],
    senior: [],
    special: '縣市,學校,地址,電話,網址,傳真\n',
  }, indexes(), '2026-07-21T00:00:00.000Z', landmarks)
  assert.equal(parsed[0].evidence.locationMethod, 'ntpc-landmark-exact')
  assert.equal(parsed[0].evidence.landmarkObjectId, 'landmark-1')
  assert.equal(parsed[0].feature.properties.facilityType, 'school-campus')
})

test('新北公園只接受可精確比對的完整門牌', () => {
  const csv = [
    '"seqno","name","area","address","management","localcallservice","areacode"',
    '"1","測試公園","板橋區","新北市板橋區文化路一段1號","","",""',
    '"2","描述位置","板橋區","文化路一段1號對面","","",""',
  ].join('\n')
  const parsed = parseNewTaipeiParks(
    csv,
    indexes()['new-taipei'].index,
    '2026-07-20T00:00:00.000Z',
  )
  assert.equal(parsed[0].feature.properties.parkType, 'park')
  assert.equal(parsed[1].excluded, 'invalidCoreFields')
})

test('臺北公園保留公園、綠地與廣場官方類型', () => {
  const rows = ['公園', '綠地', '廣場'].map((type, index) => ({
    SeqNo: String(index + 1),
    pm_name: `測試${type}`,
    pm_type: type,
    pm_location: '臺北市大安區和平東路二段1號',
    pm_Longitude: String(121.54 + index * 0.001),
    pm_Latitude: '25.04',
  }))
  const parsed = parseTaipeiParks(rows, '2026-07-20T00:00:00.000Z')
  assert.deepEqual(
    parsed.map((item) => item.feature.properties.parkType),
    ['park', 'green-space', 'plaza'],
  )
})
