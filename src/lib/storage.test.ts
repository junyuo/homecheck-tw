import { beforeEach, describe, expect, it } from 'vitest'
import { clearProperties, deleteProperty, loadSavedProperties, MAX_PROPERTIES, saveProperty } from './storage'
import type { AnalysisResult } from '../types'

const makeResult = (id: string): AnalysisResult => ({
  input: {
    id,
    city: 'taipei',
    district: 'daan',
    address: id,
    latitude: 25,
    longitude: 121,
    totalPrice: 10000000,
    areaPing: 20,
    age: 10,
    floor: 3,
    totalFloors: 10,
    buildingType: 'highrise',
    hasParking: false,
    parkingPrice: 0,
    parkingAreaPing: 0,
    radius: 500,
    floodScenario: '24h-500',
  },
  price: { unitPrice: 500000, median: null, q1: null, q3: null, sampleCount: 0, differencePercent: null, radiusUsed: 1000, parkingExcluded: false, parkingApproximate: false, insufficient: true, trend: [] },
  flood: 'unknown',
  floodDetail: { level: 'unknown', officialCategory: null, scenario: '24h-500', durationHours: 24, rainfallMm: 500, updatedAt: null, coverageConfirmed: false },
  liquefaction: 'unknown',
  liquefactionDetail: { level: 'unknown', officialCategory: null, scenario: null, durationHours: null, rainfallMm: null, updatedAt: null, coverageConfirmed: false },
  nearestMetro: null,
  nearestRail: null,
  busCount: 0,
  facilityCount: 0,
  lifeFacilities: {
    medical: { count: 0, nearestDistance: null, nearestName: null },
    parking: { count: 0, nearestDistance: null, nearestName: null },
    school: {
      count: 0,
      nearestDistance: null,
      nearestName: null,
      byLevel: { elementary: 0, junior: 0, senior: 0, special: 0 },
    },
    park: { count: 0, nearestDistance: null, nearestName: null, nearestType: null },
    market: { count: 0, nearestDistance: null, nearestName: null },
    library: { count: 0, nearestDistance: null, nearestName: null },
  },
  accidentCount: 0,
  accidentSummary: { total: 0, a1: 0, a2: 0, years: [] },
  completeness: 0,
  checklist: [],
  updatedAt: '2026-07-19',
  dataQuality: 'unavailable',
  sources: {},
})

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const storage = new MemoryStorage()

beforeEach(() => storage.clear())

describe('比較清單 Local Storage', () => {
  it('可以儲存與刪除', () => {
    saveProperty(makeResult('a'), 'A', storage)
    saveProperty(makeResult('b'), 'B', storage)
    expect(loadSavedProperties(storage)).toHaveLength(2)
    expect(deleteProperty('a', storage).map((x) => x.id)).toEqual(['b'])
    clearProperties(storage)
    expect(loadSavedProperties(storage)).toEqual([])
  })

  it('最多儲存三筆', () => {
    for (let index = 0; index < MAX_PROPERTIES; index += 1) saveProperty(makeResult(String(index)), String(index), storage)
    expect(() => saveProperty(makeResult('overflow'), 'overflow', storage)).toThrow('最多只能保存三間房屋')
    expect(loadSavedProperties(storage)).toHaveLength(3)
  })

  it('舊 Demo 陣列會遷移為歷史 Demo', () => {
    const legacy = { ...makeResult('legacy'), demo: true }
    delete (legacy as Partial<AnalysisResult>).dataQuality
    storage.setItem('homecheck-tw:properties', JSON.stringify([{
      id: 'legacy',
      savedAt: '2026-07-19',
      label: '舊資料',
      result: legacy,
    }]))
    const [migrated] = loadSavedProperties(storage)
    expect(migrated.historicDemo).toBe(true)
    expect(migrated.result.dataQuality).toBe('historic-demo')
  })

  it('v2 比較紀錄保留並標示災害快照需重新查詢', () => {
    const result = makeResult('v2')
    const legacyInput = { ...result.input } as Partial<typeof result.input>
    delete legacyInput.floodScenario
    const legacyResult = { ...result, input: legacyInput }
    delete (legacyResult as Partial<AnalysisResult>).floodDetail
    delete (legacyResult as Partial<AnalysisResult>).liquefactionDetail
    storage.setItem('homecheck-tw:properties', JSON.stringify({
      schemaVersion: 2,
      properties: [{ id: 'v2', savedAt: '2026-07-19', label: '舊快照', result: legacyResult }],
    }))
    const [migrated] = loadSavedProperties(storage)
    expect(migrated.riskSnapshotLegacy).toBe(true)
    expect(migrated.result.input.floodScenario).toBe('24h-500')
    expect(migrated.result.floodDetail.level).toBe('unknown')
  })

  it('v3 比較紀錄保留總數並標示生活機能明細需重新查詢', () => {
    const result = makeResult('v3')
    const legacyResult = { ...result } as Partial<AnalysisResult>
    delete legacyResult.lifeFacilities
    storage.setItem('homecheck-tw:properties', JSON.stringify({
      schemaVersion: 3,
      properties: [{ id: 'v3', savedAt: '2026-07-19', label: '舊快照', result: legacyResult }],
    }))
    const [migrated] = loadSavedProperties(storage)
    expect(migrated.lifeSnapshotLegacy).toBe(true)
    expect(migrated.riskSnapshotLegacy).toBe(false)
    expect(migrated.result.facilityCount).toBe(0)
    expect(migrated.result.lifeFacilities.medical.count).toBe(0)
  })

  it('v4 保留醫院與停車場，只有學校與公園標示舊快照', () => {
    const result = makeResult('v4')
    const legacy = structuredClone(result)
    delete (legacy.lifeFacilities as Partial<typeof legacy.lifeFacilities>).school
    delete (legacy.lifeFacilities as Partial<typeof legacy.lifeFacilities>).park
    storage.setItem('homecheck-tw:properties', JSON.stringify({
      schemaVersion: 4,
      properties: [{ id: 'v4', savedAt: '2026-07-19', label: '舊快照', result: legacy }],
    }))
    const [migrated] = loadSavedProperties(storage)
    expect(migrated.lifeSnapshotLegacy).toBe(false)
    expect(migrated.communitySnapshotLegacy).toBe(true)
    expect(migrated.result.lifeFacilities.school.count).toBe(0)
    expect(migrated.result.lifeFacilities.park.count).toBe(0)
  })

  it('v5 保留事故總數並標示 A1/A2 明細需重新查詢', () => {
    const result = makeResult('v5')
    const legacy = structuredClone(result) as Partial<AnalysisResult>
    delete legacy.accidentSummary
    storage.setItem('homecheck-tw:properties', JSON.stringify({
      schemaVersion: 5,
      properties: [{ id: 'v5', savedAt: '2026-07-19', label: '舊快照', result: legacy }],
    }))
    const [migrated] = loadSavedProperties(storage)
    expect(migrated.accidentSnapshotLegacy).toBe(true)
    expect(migrated.result.accidentSummary.total).toBe(0)
  })

  it('v6 保留事故明細並標示圖書館快照需重新查詢', () => {
    const result = makeResult('v6')
    const legacy = structuredClone(result)
    delete (legacy.lifeFacilities as Partial<typeof legacy.lifeFacilities>).library
    storage.setItem('homecheck-tw:properties', JSON.stringify({
      schemaVersion: 6,
      properties: [{ id: 'v6', savedAt: '2026-07-21', label: '舊快照', result: legacy }],
    }))
    const [migrated] = loadSavedProperties(storage)
    expect(migrated.accidentSnapshotLegacy).toBe(false)
    expect(migrated.librarySnapshotLegacy).toBe(true)
    expect(migrated.result.lifeFacilities.library.count).toBe(0)
  })

  it('v7 保留既有資料並只標示市場快照需重新查詢', () => {
    const result = makeResult('v7')
    const legacy = structuredClone(result)
    delete (legacy.lifeFacilities as Partial<typeof legacy.lifeFacilities>).market
    storage.setItem('homecheck-tw:properties', JSON.stringify({
      schemaVersion: 7,
      properties: [{ id: 'v7', savedAt: '2026-07-23', label: '舊快照', result: legacy }],
    }))
    const [migrated] = loadSavedProperties(storage)
    expect(migrated.librarySnapshotLegacy).toBe(false)
    expect(migrated.marketSnapshotLegacy).toBe(true)
    expect(migrated.result.lifeFacilities.market.count).toBe(0)
  })
})
