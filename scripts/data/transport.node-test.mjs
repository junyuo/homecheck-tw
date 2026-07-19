import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dedupeRailStations,
  districtFromAddress,
  parseRailGps,
  pointMatchesDistrict,
} from './transport.mjs'

test('臺鐵 GPS 固定解析為緯度、經度', () => {
  assert.deepEqual(parseRailGps('25.04771 121.51784'), {
    latitude: 25.04771,
    longitude: 121.51784,
  })
  assert.equal(parseRailGps('121.51784,25.04771'), null)
  assert.equal(parseRailGps('24 120'), null)
})

test('臺鐵地址只接受雙北且能指定行政區', () => {
  assert.deepEqual(districtFromAddress('臺北市中正區北平西路 3 號'), {
    city: 'taipei',
    district: 'zhongzheng',
  })
  assert.deepEqual(districtFromAddress('新北市瑞芳區明燈路三段 82 號'), {
    city: 'new-taipei',
    district: 'ruifang',
  })
  assert.equal(districtFromAddress('基隆市仁愛區'), null)
})

test('臺鐵座標必須落在地址所屬行政區界內', () => {
  const boundary = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [121.4, 25],
          [121.6, 25],
          [121.6, 25.2],
          [121.4, 25.2],
          [121.4, 25],
        ]],
      },
    }],
  }
  assert.equal(pointMatchesDistrict(boundary, {
    latitude: 25.1,
    longitude: 121.5,
  }), true)
  assert.equal(pointMatchesDistrict(boundary, {
    latitude: 24.9,
    longitude: 121.5,
  }), false)
  assert.equal(pointMatchesDistrict(boundary, {
    latitude: 24.9999,
    longitude: 121.5,
  }, 20), true)
})

test('同名且 150 公尺內的臺鐵站碼合併，不合併不同站名', () => {
  const stations = dedupeRailStations([
    { stationCode: '1001', name: '臺北', latitude: 25.04774, longitude: 121.51711 },
    { stationCode: '1000', name: '臺北', latitude: 25.04771, longitude: 121.51784 },
    { stationCode: '1002', name: '另一站', latitude: 25.04772, longitude: 121.5178 },
  ])
  assert.equal(stations.length, 2)
  assert.deepEqual(stations[0].stationCodes, ['1000', '1001'])
  assert.equal(stations[1].name, '另一站')
})
