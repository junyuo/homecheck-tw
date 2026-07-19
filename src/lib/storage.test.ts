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
  },
  price: { unitPrice: 500000, median: null, q1: null, q3: null, sampleCount: 0, differencePercent: null, radiusUsed: 1000, parkingExcluded: false, parkingApproximate: false, insufficient: true, trend: [] },
  flood: 'unknown',
  liquefaction: 'unknown',
  nearestMetro: null,
  nearestRail: null,
  busCount: 0,
  facilityCount: 0,
  accidentCount: 0,
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
})
