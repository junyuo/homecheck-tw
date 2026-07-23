import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import distance from '@turf/distance'
import { point } from '@turf/helpers'
import type {
  AnalysisResult,
  ChecklistItem,
  DistrictDataset,
  PointCollection,
  PriceAnalysis,
  PropertyInput,
  RiskCollection,
  RiskFinding,
  RiskLevel,
  Transaction,
} from '../types'

export function calculateUnitPrice(
  totalPrice: number,
  areaPing: number,
  parkingPrice = 0,
  parkingAreaPing = 0,
): number {
  const netArea = areaPing - Math.max(0, parkingAreaPing)
  if (netArea <= 0) return 0
  return Math.round(((totalPrice - Math.max(0, parkingPrice)) / netArea) * 100) / 100
}

export function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * percentile
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const weight = position - lower
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight
}

export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  return distance(point([a.longitude, a.latitude]), point([b.longitude, b.latitude]), {
    units: 'kilometers',
  }) * 1000
}

export function pointsWithinRadius<T>(
  collection: PointCollection<T>,
  location: { latitude: number; longitude: number },
  radius: number,
): PointCollection<T>['features'] {
  return collection.features.filter((feature) =>
    distanceMeters(location, {
      latitude: feature.geometry.coordinates[1],
      longitude: feature.geometry.coordinates[0],
    }) <= radius,
  )
}

export function riskAtPoint(
  location: { latitude: number; longitude: number },
  collection: RiskCollection,
): RiskLevel {
  const match = collection.features.find((feature) =>
    booleanPointInPolygon(point([location.longitude, location.latitude]), feature),
  )
  return match?.properties.level ?? 'unknown'
}

export function riskFindingAtPoint(
  location: { latitude: number; longitude: number },
  collection: RiskCollection | null,
): RiskFinding {
  const match = collection?.features.find((feature) =>
    booleanPointInPolygon(point([location.longitude, location.latitude]), feature),
  )
  if (!match) {
    return {
      level: 'unknown',
      officialCategory: null,
      scenario: null,
      durationHours: null,
      rainfallMm: null,
      updatedAt: null,
      coverageConfirmed: false,
    }
  }
  return {
    level: match.properties.level,
    officialCategory: match.properties.officialCategory,
    scenario: match.properties.scenario as RiskFinding['scenario'] ?? null,
    durationHours: match.properties.durationHours ?? null,
    rainfallMm: match.properties.rainfallMm ?? null,
    updatedAt: match.properties.updatedAt,
    coverageConfirmed: match.properties.coverageConfirmed === true,
  }
}

function comparableTransactions(
  input: PropertyInput,
  transactions: Transaction[],
  radius: number,
): Transaction[] {
  return transactions.filter((transaction) => {
    const closeEnough = distanceMeters(input, transaction) <= radius
    const ageMatch = Math.abs(transaction.age - input.age) <= 10
    return closeEnough &&
      ageMatch &&
      transaction.buildingType === input.buildingType &&
      !transaction.specialTransaction
  })
}

export function analyzePrice(input: PropertyInput, transactions: Transaction[]): PriceAnalysis {
  let radiusUsed = 500
  let comparable = comparableTransactions(input, transactions, radiusUsed)
  if (comparable.length < 5) {
    radiusUsed = 1000
    comparable = comparableTransactions(input, transactions, radiusUsed)
  }
  const prices = comparable.map((item) =>
    calculateUnitPrice(
      item.totalPrice,
      item.areaPing,
      item.parkingPrice ?? 0,
      item.parkingAreaPing ?? 0,
    ),
  )
  const median = quantile(prices, 0.5)
  const unitPrice = calculateUnitPrice(
    input.totalPrice,
    input.areaPing,
    input.hasParking ? input.parkingPrice : 0,
    input.hasParking ? input.parkingAreaPing : 0,
  )
  const differencePercent = median && comparable.length >= 5
    ? ((unitPrice - median) / median) * 100
    : null
  const byYear = new Map<number, number[]>()
  comparable.forEach((item) => {
    const year = new Date(item.date).getFullYear()
    byYear.set(year, [...(byYear.get(year) ?? []), calculateUnitPrice(
      item.totalPrice,
      item.areaPing,
      item.parkingPrice,
      item.parkingAreaPing,
    )])
  })
  return {
    unitPrice,
    median,
    q1: quantile(prices, 0.25),
    q3: quantile(prices, 0.75),
    sampleCount: comparable.length,
    differencePercent,
    radiusUsed,
    parkingExcluded: input.hasParking && input.parkingPrice > 0,
    parkingApproximate: input.hasParking && input.parkingPrice > 0 && input.parkingAreaPing <= 0,
    insufficient: comparable.length < 5,
    trend: [...byYear.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, values]) => ({
        year,
        median: quantile(values, 0.5) ?? 0,
        sampleCount: values.length,
      })),
  }
}

function makeChecklist(
  price: PriceAnalysis,
  flood: RiskLevel,
  liquefaction: RiskLevel,
  accidentCount: number,
): ChecklistItem[] {
  const items: ChecklistItem[] = []
  if (flood !== 'low') items.push({
    id: 'flood',
    text: '地下室或一樓過去是否發生淹水？社區有哪些防水與抽水措施？',
    level: flood,
    checked: false,
  })
  if (liquefaction !== 'low') items.push({
    id: 'liquefaction',
    text: '可以取得基地地質調查、地質改良及建物結構資料嗎？',
    level: liquefaction,
    checked: false,
  })
  if (price.insufficient || (price.differencePercent ?? 0) > 10) items.push({
    id: 'price',
    text: price.insufficient
      ? '可否提供更多同社區或鄰近相似物件的近期成交資料？'
      : '開價包含哪些裝潢、設備與車位價值？議價依據為何？',
    level: price.insufficient ? 'unknown' : 'attention',
    checked: false,
  })
  if (accidentCount > 0) items.push({
    id: 'traffic',
    text: '尖峰與夜間的車流、噪音及行人安全狀況如何？',
    level: 'attention',
    checked: false,
  })
  items.push(
    { id: 'repair', text: '社區是否有重大修繕、漏水或外牆維護紀錄？', level: 'attention', checked: false },
    { id: 'fund', text: '管委會公共基金餘額與近期重大支出為何？', level: 'attention', checked: false },
    { id: 'license', text: '是否可以取得建物使用執照與車位權利資料？', level: 'attention', checked: false },
  )
  const rank: Record<RiskLevel, number> = { priority: 0, attention: 1, unknown: 2, low: 3 }
  return items.sort((a, b) => rank[a.level] - rank[b.level])
}

export function buildAnalysis(
  input: PropertyInput,
  dataset: DistrictDataset,
  flood: RiskCollection | null = dataset.flood,
  liquefaction: RiskCollection | null = dataset.liquefaction,
): AnalysisResult {
  const price = analyzePrice(input, dataset.transactions)
  const nearbyFacilities = pointsWithinRadius(dataset.facilities, input, input.radius)
  const nearbyAccidents = pointsWithinRadius(dataset.accidents, input, input.radius)
  const metro = dataset.facilities.features.filter((feature) => feature.properties.category === 'metro')
  const rail = dataset.facilities.features.filter((feature) => feature.properties.category === 'rail')
  const nearest = (features: typeof metro) => features.length
    ? Math.min(...features.map((feature) => distanceMeters(input, {
      latitude: feature.geometry.coordinates[1],
      longitude: feature.geometry.coordinates[0],
    })))
    : null
  const summarizeLifeFacility = (category: 'medical' | 'parking' | 'school' | 'park' | 'library') => {
    const all = dataset.facilities.features.filter((feature) => feature.properties.category === category)
    const nearby = nearbyFacilities.filter((feature) => feature.properties.category === category)
    const closest = all
      .map((feature) => ({
        name: feature.properties.name,
        parkType: feature.properties.parkType,
        distance: distanceMeters(input, {
          latitude: feature.geometry.coordinates[1],
          longitude: feature.geometry.coordinates[0],
        }),
      }))
      .sort((a, b) => a.distance - b.distance)[0]
    return {
      count: nearby.length,
      nearestDistance: closest?.distance ?? null,
      nearestName: closest?.name ?? null,
    }
  }
  const schoolSummary = {
    ...summarizeLifeFacility('school'),
    byLevel: {
      elementary: nearbyFacilities.filter((feature) =>
        feature.properties.category === 'school' &&
        feature.properties.schoolLevels?.includes('elementary')).length,
      junior: nearbyFacilities.filter((feature) =>
        feature.properties.category === 'school' &&
        feature.properties.schoolLevels?.includes('junior')).length,
      senior: nearbyFacilities.filter((feature) =>
        feature.properties.category === 'school' &&
        feature.properties.schoolLevels?.includes('senior')).length,
      special: nearbyFacilities.filter((feature) =>
        feature.properties.category === 'school' &&
        feature.properties.schoolLevels?.includes('special')).length,
    },
  }
  const closestPark = dataset.facilities.features
    .filter((feature) => feature.properties.category === 'park')
    .map((feature) => ({
      parkType: feature.properties.parkType ?? null,
      distance: distanceMeters(input, {
        latitude: feature.geometry.coordinates[1],
        longitude: feature.geometry.coordinates[0],
      }),
    }))
    .sort((a, b) => a.distance - b.distance)[0]
  const parkSummary = {
    ...summarizeLifeFacility('park'),
    nearestType: closestPark?.parkType ?? null,
  }
  const floodDetail = riskFindingAtPoint(input, flood)
  const liquefactionDetail = riskFindingAtPoint(input, liquefaction)
  const floodLevel = floodDetail.level
  const liquefactionLevel = liquefactionDetail.level
  const completenessSignals = [
    price.sampleCount >= 5,
    floodLevel !== 'unknown',
    liquefactionLevel !== 'unknown',
    metro.length > 0 || rail.length > 0,
    dataset.facilities.features.some((feature) =>
      !['metro', 'rail', 'bus'].includes(feature.properties.category)),
    ['official', 'stale'].includes(dataset.sources.accidents?.status ?? ''),
  ]
  const sourceStatuses = Object.values(dataset.sources).map((source) => source.status)
  const officialCount = sourceStatuses.filter((status) => status === 'official').length
  const dataQuality = officialCount === 0
    ? 'unavailable'
    : sourceStatuses.every((status) => status === 'official')
      ? 'official'
      : 'mixed'
  return {
    input,
    price,
    flood: floodLevel,
    floodDetail: {
      ...floodDetail,
      scenario: input.floodScenario,
      durationHours: floodDetail.durationHours ??
        Number(input.floodScenario.match(/^(\d+)h/)?.[1] ?? 0),
      rainfallMm: floodDetail.rainfallMm ??
        Number(input.floodScenario.match(/-(\d+)$/)?.[1] ?? 0),
    },
    liquefaction: liquefactionLevel,
    liquefactionDetail,
    nearestMetro: nearest(metro),
    nearestRail: nearest(rail),
    busCount: nearbyFacilities.filter((item) => item.properties.category === 'bus').length,
    facilityCount: nearbyFacilities.filter((item) => !['metro', 'rail', 'bus'].includes(item.properties.category)).length,
    lifeFacilities: {
      medical: summarizeLifeFacility('medical'),
      parking: summarizeLifeFacility('parking'),
      school: schoolSummary,
      park: parkSummary,
      library: summarizeLifeFacility('library'),
    },
    accidentCount: nearbyAccidents.length,
    accidentSummary: {
      total: nearbyAccidents.length,
      a1: nearbyAccidents.filter((item) => item.properties.severity === 'A1').length,
      a2: nearbyAccidents.filter((item) => item.properties.severity === 'A2').length,
      years: [...new Set([
        ...(dataset.sources.accidents?.years ?? []),
        ...dataset.accidents.features.map((item) => item.properties.year),
      ])]
        .filter(Number.isInteger)
        .sort((a, b) => a - b),
    },
    completeness: Math.round(completenessSignals.filter(Boolean).length / completenessSignals.length * 100),
    checklist: makeChecklist(price, floodLevel, liquefactionLevel, nearbyAccidents.length),
    updatedAt: dataset.updatedAt,
    dataQuality,
    sources: dataset.sources,
  }
}
