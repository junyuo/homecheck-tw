import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLibraries, qualityLibraries } from './library.mjs'

const updatedAt = '2026-07-21T00:00:00.000Z'

function source(rows) {
  return [{ 縣市: '臺北市', 圖書館資訊: rows }]
}

test('公共圖書館只保留地址、行政區與官方座標一致的雙北紀錄', () => {
  const parsed = parseLibraries(source([
    {
      Name: '臺北市立圖書館總館',
      Area: '大安區',
      Address: '臺北市大安區建國南路二段125號',
      Longitude: 121.5384,
      Latitude: 25.0292,
    },
    {
      Name: '行政區衝突',
      Area: '中正區',
      Address: '臺北市大安區測試路1號',
      Longitude: 121.5384,
      Latitude: 25.0292,
    },
  ]), updatedAt)
  assert.equal(parsed[0].feature.properties.category, 'library')
  assert.equal(parsed[0].feature.properties.facilityType, 'public-library')
  assert.equal('address' in parsed[0].feature.properties, false)
  assert.equal(parsed[1].excluded, 'invalidCoreFields')
})

test('公共圖書館合併同名同址重複資料並阻擋行政區界外座標', () => {
  const row = {
    Name: '測試圖書館',
    Area: '大安區',
    Address: '臺北市大安區測試路1號',
    Longitude: 121.54,
    Latitude: 25.04,
  }
  const parsed = parseLibraries(source([row, row, { ...row, Name: '界外館', Longitude: 121.7 }]), updatedAt)
  const boundary = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[121.5, 25], [121.58, 25], [121.58, 25.08], [121.5, 25.08], [121.5, 25]]],
      },
    }],
  }
  const quality = qualityLibraries(parsed, new Map([['taipei/daan', boundary]]))
  assert.equal(quality.accepted.length, 1)
  assert.equal(quality.excluded.mergedDuplicate, 1)
  assert.equal(quality.excluded.districtMismatch, 1)
})
