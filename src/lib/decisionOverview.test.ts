import { describe, expect, it } from 'vitest'
import { buildDecisionOverview, formatTaiwanDate } from './decisionOverview'
import type { AnalysisResult, RuntimeSourceState } from '../types'

const source = (status: RuntimeSourceState['status'] = 'official'): RuntimeSourceState => ({
  status,
  updatedAt: '2026-07-21',
  message: '',
})

const result = (city: 'taipei' | 'new-taipei'): AnalysisResult => ({
  input: {
    city, district: 'daan', address: '測試', latitude: 25, longitude: 121,
    totalPrice: 20000000, areaPing: 40, age: 20, floor: 5, totalFloors: 12,
    buildingType: 'highrise', hasParking: false, parkingPrice: 0, parkingAreaPing: 0,
    radius: 500, floodScenario: '24h-500',
  },
  price: { unitPrice: 500000, median: 480000, q1: 450000, q3: 510000, sampleCount: 8, differencePercent: 4, radiusUsed: 500, parkingExcluded: false, parkingApproximate: false, insufficient: false, trend: [] },
  flood: 'low',
  floodDetail: { level: 'low', officialCategory: '0.3m 以下', scenario: '24h-500', durationHours: 24, rainfallMm: 500, updatedAt: '2026-07-21', coverageConfirmed: true },
  liquefaction: 'attention',
  liquefactionDetail: { level: 'attention', officialCategory: '中', scenario: null, durationHours: null, rainfallMm: null, updatedAt: '2026-07-21', coverageConfirmed: true },
  nearestMetro: 100,
  nearestRail: null,
  busCount: 2,
  facilityCount: 3,
  lifeFacilities: {
    medical: { count: 1, nearestDistance: 100, nearestName: '醫院' },
    parking: { count: 1, nearestDistance: 100, nearestName: '停車場' },
    school: { count: 1, nearestDistance: 100, nearestName: '學校', byLevel: { elementary: 1, junior: 0, senior: 0, special: 0 } },
    park: { count: 0, nearestDistance: null, nearestName: null, nearestType: null },
    library: { count: 1, nearestDistance: 100, nearestName: '圖書館' },
  },
  accidentCount: 2,
  accidentSummary: { total: 2, a1: 0, a2: 2, years: [2023, 2024, 2025] },
  completeness: 100,
  checklist: [{ id: 'one', text: '第一項', level: 'attention', checked: false }, { id: 'done', text: '已完成', level: 'low', checked: true }],
  updatedAt: '2026-07-21T16:30:00Z',
  dataQuality: 'mixed',
  sources: {
    'actual-price': source(), flood: source(), liquefaction: source(), metro: source(), rail: source(), accidents: source(),
    'bus-taipei': source('unavailable'), 'bus-new-taipei': source(), medical: source(), parking: source(), school: source(),
    park: source('unavailable'), market: source('unavailable'), library: source(),
  },
})

describe('決策摘要', () => {
  it('臺北明確顯示公車、公園與市場缺口', () => {
    const overview = buildDecisionOverview(result('taipei'))
    expect(overview.dimensions.find((item) => item.id === 'transport')?.value).toBe('可用 3/4 來源')
    expect(overview.dimensions.find((item) => item.id === 'life')?.value).toBe('可用 4/6 類')
    expect(overview.dataGaps).toEqual(expect.arrayContaining(['臺北市公車站位未接入', '公園綠地未達發布門檻', '市場資料尚未接入']))
    expect(overview.priorityActions).toEqual(['第一項'])
  })

  it('新北使用新北公車來源判定交通完整', () => {
    const overview = buildDecisionOverview(result('new-taipei'))
    expect(overview.dimensions.find((item) => item.id === 'transport')?.availability).toBe('official')
    expect(overview.dataGaps).not.toContain('臺北市公車站位未接入')
  })

  it('日期以臺灣時區顯示', () => {
    expect(formatTaiwanDate('2026-07-21T16:30:00Z')).toBe('2026/07/22')
    expect(formatTaiwanDate(null)).toBe('日期不明')
  })
})
