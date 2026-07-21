import assert from 'node:assert/strict'
import test from 'node:test'
import { accidentHeader, parseAccidentRecord } from './accidents.mjs'

const row = {
  '發生年度': '2024',
  '發生日期': '20240101',
  '發生時間': '095600',
  '事故類別名稱': 'A1',
  '處理單位名稱警局層': '臺北市政府警察局',
  '發生地點': '臺北市大安區測試路口',
  '經度': '121.54312349',
  '緯度': '25.03312349',
}

test('事故資料正規化日期、等級、六位座標與穩定 ID', () => {
  const first = parseAccidentRecord(row, 2024, 'A1')
  const second = parseAccidentRecord({ ...row }, 2024, 'A1')
  assert.equal(first.date, '2024-01-01')
  assert.equal(first.severity, 'A1')
  assert.deepEqual(first.coordinate, { longitude: 121.543123, latitude: 25.033123 })
  assert.equal(first.id, second.id)
})

test('事故資料拒絕錯誤年度、等級與座標', () => {
  assert.equal(parseAccidentRecord(row, 2023, 'A1').excluded, 'invalidDate')
  assert.equal(parseAccidentRecord(row, 2024, 'A2').excluded, 'invalidSeverity')
  assert.equal(parseAccidentRecord({ ...row, '經度': 'x' }, 2024, 'A1').excluded, 'invalidCoordinate')
})

test('ZIP 串流可從 metadata 黏連行找回真正 CSV header', () => {
  const header = accidentHeader('description,描述\uFEFF發生年度,發生日期,事故類別名稱,經度,緯度')
  assert.deepEqual(header, ['發生年度', '發生日期', '事故類別名稱', '經度', '緯度'])
})
