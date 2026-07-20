import { describe, expect, it } from 'vitest'
import { analyzePrice, buildAnalysis, calculateUnitPrice, pointsWithinRadius, quantile, riskAtPoint } from './analysis'
import type { DistrictDataset, PointCollection, PropertyInput, RiskCollection, Transaction } from '../types'

const input: PropertyInput = {
  city: 'taipei',
  district: 'daan',
  address: '測試',
  latitude: 25.033,
  longitude: 121.543,
  totalPrice: 20000000,
  areaPing: 40,
  age: 20,
  floor: 5,
  totalFloors: 12,
  buildingType: 'highrise',
  hasParking: false,
  parkingPrice: 0,
  parkingAreaPing: 0,
  radius: 500,
  floodScenario: '24h-500',
}

describe('價格計算', () => {
  it('以總價與坪數換算單價', () => {
    expect(calculateUnitPrice(20000000, 40)).toBe(500000)
  })

  it('排除車位價格後換算單價', () => {
    expect(calculateUnitPrice(20000000, 40, 2000000)).toBe(450000)
  })

  it('同時排除車位價格與坪數', () => {
    expect(calculateUnitPrice(20000000, 40, 2000000, 10)).toBe(600000)
  })

  it('計算中位數及四分位數', () => {
    const values = [10, 20, 30, 40, 50]
    expect(quantile(values, 0.25)).toBe(20)
    expect(quantile(values, 0.5)).toBe(30)
    expect(quantile(values, 0.75)).toBe(40)
  })

  it('樣本少於 5 筆時標示資料不足且不產生價差', () => {
    const transactions: Transaction[] = Array.from({ length: 4 }, (_, index) => ({
      id: String(index),
      date: '2025-01-01',
      latitude: 25.033 + index * 0.0001,
      longitude: 121.543,
      totalPrice: 18000000,
      areaPing: 40,
      age: 20,
      floor: 5,
      buildingType: 'highrise',
      specialTransaction: false,
    }))
    const result = analyzePrice(input, transactions)
    expect(result.insufficient).toBe(true)
    expect(result.sampleCount).toBe(4)
    expect(result.differencePercent).toBeNull()
  })
})

describe('空間分析', () => {
  it('判斷點是否位於生活圈距離內', () => {
    const facilities: PointCollection<{ name: string }> = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: '近點' }, geometry: { type: 'Point', coordinates: [121.5431, 25.0331] } },
        { type: 'Feature', properties: { name: '遠點' }, geometry: { type: 'Point', coordinates: [121.56, 25.05] } },
      ],
    }
    expect(pointsWithinRadius(facilities, input, 500).map((x) => x.properties.name)).toEqual(['近點'])
  })

  it('分別計算四類生活機能數量及最近點位', () => {
    const dataset: DistrictDataset = {
      transactions: [],
      facilities: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { name: '近醫院', category: 'medical' }, geometry: { type: 'Point', coordinates: [121.5431, 25.0331] } },
          { type: 'Feature', properties: { name: '遠醫院', category: 'medical' }, geometry: { type: 'Point', coordinates: [121.56, 25.05] } },
          { type: 'Feature', properties: { name: '近停車場', category: 'parking' }, geometry: { type: 'Point', coordinates: [121.5432, 25.0332] } },
          { type: 'Feature', properties: { name: '測試校園', category: 'school', schoolLevels: ['elementary', 'junior'] }, geometry: { type: 'Point', coordinates: [121.5433, 25.0333] } },
          { type: 'Feature', properties: { name: '測試綠地', category: 'park', parkType: 'green-space' }, geometry: { type: 'Point', coordinates: [121.5434, 25.0334] } },
        ],
      },
      accidents: { type: 'FeatureCollection', features: [] },
      flood: null,
      floodScenario: '24h-500',
      availableFloodScenarios: [],
      liquefaction: null,
      sources: {},
      updatedAt: '2026-07-20',
    }
    const result = buildAnalysis(input, dataset)
    expect(result.lifeFacilities.medical.count).toBe(1)
    expect(result.lifeFacilities.medical.nearestName).toBe('近醫院')
    expect(result.lifeFacilities.parking.count).toBe(1)
    expect(result.lifeFacilities.parking.nearestName).toBe('近停車場')
    expect(result.lifeFacilities.school.byLevel.elementary).toBe(1)
    expect(result.lifeFacilities.school.byLevel.junior).toBe(1)
    expect(result.lifeFacilities.park.nearestType).toBe('green-space')
  })

  it('判斷點是否落在風險多邊形內', () => {
    const layer: RiskCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {
          name: '測試區',
          level: 'attention',
          sourceType: 'official',
          officialCategory: '中',
          riskType: 'liquefaction',
          updatedAt: '2026-07-19',
        },
        geometry: { type: 'Polygon', coordinates: [[[121.54, 25.03], [121.55, 25.03], [121.55, 25.04], [121.54, 25.04], [121.54, 25.03]]] },
      }],
    }
    expect(riskAtPoint(input, layer)).toBe('attention')
    expect(riskAtPoint({ latitude: 24, longitude: 120 }, layer)).toBe('unknown')
  })
})
