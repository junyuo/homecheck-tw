import assert from 'node:assert/strict'
import test from 'node:test'
import { addressKey, matchAddress } from './address-index.mjs'
import {
  parseNewTaipeiHospitals,
  parseNewTaipeiParking,
  parseTaipeiParking,
} from './facilities.mjs'

const updatedAt = '2026-07-20T00:00:00.000Z'

test('雙北停車場格式、汽車格位與 TWD97 轉換', () => {
  const taipei = parseTaipeiParking({
    data: {
      park: [
        { id: 'tp-1', name: '測試停車場', area: '大安區', totalcar: '10', tw97x: '306948', tw97y: '2770968' },
        { id: 'tp-2', name: '無汽車格', area: '大安區', totalcar: '0', tw97x: '306948', tw97y: '2770968' },
      ],
    },
  }, updatedAt)
  assert.equal(taipei[0].feature.properties.carCapacity, 10)
  assert.equal(taipei[0].feature.properties.facilityType, 'offstreet-parking')
  assert.ok(taipei[0].coordinate.longitude > 121.4)
  assert.equal(taipei[1].excluded, 'invalidCoreFields')

  const csv = [
    'ID,AREA,NAME,TOTALCAR,TW97X,TW97Y',
    'ntp-1,板橋區,板橋停車場,25,297000,2768000',
  ].join('\n')
  const [newTaipei] = parseNewTaipeiParking(csv, updatedAt)
  assert.equal(newTaipei.city, 'new-taipei')
  assert.equal(newTaipei.feature.properties.carCapacity, 25)
})

test('新北醫院只接受精確且單一的門牌匹配', () => {
  const coordinate = { longitude: 121.46, latitude: 25.01 }
  const index = new Map([
    [addressKey('板橋區', '文化路一段1號'), coordinate],
  ])
  const csv = [
    'hosp_id,hosp_name,hosp_addr,area',
    'h1,測試醫院,新北市板橋區文化路一段1號,板橋區',
    'h2,多址醫院,新北市板橋區文化路一段1號、2號,板橋區',
    'h3,未知醫院,新北市板橋區文化路一段99號,板橋區',
  ].join('\n')
  const parsed = parseNewTaipeiHospitals(csv, index, updatedAt)
  assert.equal(parsed[0].feature.properties.facilityType, 'hospital')
  assert.equal(parsed[0].feature.properties.id.length, 24)
  assert.equal(parsed[1].excluded, 'multipleAddress')
  assert.equal(parsed[2].excluded, 'unmatchedAddress')
})

test('設施門牌變體不改寫共用價格索引鍵', () => {
  const coordinate = { longitude: 121.46, latitude: 25.01 }
  const index = new Map([
    [addressKey('板橋區', '文化路一段1號'), coordinate],
  ])
  assert.deepEqual(
    matchAddress(index, '新北市板橋區新民里文化路1段一號', 'new-taipei', '板橋區'),
    { status: 'matched', coordinate },
  )
  assert.equal(addressKey('板橋區', '文化路一段1號'), '板橋區|文化路一段1號')
})
