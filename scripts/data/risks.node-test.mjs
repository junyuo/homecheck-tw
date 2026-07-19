import assert from 'node:assert/strict'
import test from 'node:test'
import { FLOOD_SCENARIOS } from './constants.mjs'
import {
  assertDepthQuality,
  floodDepthLevel,
  liquefactionClassLevel,
  polygonGeometries,
  validateShapefileEntries,
} from './risks.mjs'

test('淹水固定提供十種官方降雨情境', () => {
  assert.equal(FLOOD_SCENARIOS.length, 10)
  assert.deepEqual(
    FLOOD_SCENARIOS.map((item) => item.id),
    [
      '6h-150', '6h-250', '6h-350',
      '12h-200', '12h-300', '12h-400',
      '24h-200', '24h-350', '24h-500', '24h-650',
    ],
  )
})

test('淹水深度級距映射並拒絕未知值', () => {
  assert.equal(floodDepthLevel('0.3-0.5'), 'attention')
  assert.equal(floodDepthLevel('0.5-1.0'), 'priority')
  assert.equal(floodDepthLevel('>3.0'), 'priority')
  assert.equal(floodDepthLevel('0.3-0.>3.0'), null)
  assert.equal(floodDepthLevel(''), null)
})

test('臺北液化官方 class 對應高、中、低', () => {
  assert.equal(liquefactionClassLevel(1), 'priority')
  assert.equal(liquefactionClassLevel(2), 'attention')
  assert.equal(liquefactionClassLevel(3), 'low')
  assert.equal(liquefactionClassLevel(4), null)
})

test('裁切後只保留可供前端判讀的面 geometry', () => {
  const polygon = { type: 'Polygon', coordinates: [[[121.5, 25], [121.6, 25], [121.5, 25]]] }
  assert.deepEqual(polygonGeometries({
    type: 'GeometryCollection',
    geometries: [
      polygon,
      { type: 'LineString', coordinates: [[121.5, 25], [121.6, 25]] },
    ],
  }), [polygon])
  assert.deepEqual(polygonGeometries(null), [])
})

test('SHP ZIP 必須同時包含 DBF、PRJ 與 SHX', () => {
  const valid = ['layer.shp', 'layer.dbf', 'layer.prj', 'layer.shx']
  assert.equal(validateShapefileEntries(valid), 'layer.shp')
  assert.throws(
    () => validateShapefileEntries(valid.filter((entry) => !entry.endsWith('.dbf'))),
    /缺少 DBF/,
  )
  assert.throws(
    () => validateShapefileEntries(valid.filter((entry) => !entry.endsWith('.prj'))),
    /缺少 PRJ/,
  )
})

test('未知淹水深度級距超過 2% 時拒絕整批', () => {
  assert.equal(assertDepthQuality(100, 2, '24h-500'), 0.02)
  assert.throws(() => assertDepthQuality(100, 3, '24h-500'), /超過 2%/)
  assert.throws(() => assertDepthQuality(0, 0, '24h-500'), /超過 2%/)
})
