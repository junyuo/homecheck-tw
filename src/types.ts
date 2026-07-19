import type { FeatureCollection, Point, Polygon, MultiPolygon } from 'geojson'

export type RiskLevel = 'low' | 'attention' | 'priority' | 'unknown'
export type BuildingType = 'apartment' | 'mansion' | 'highrise'

export interface PropertyInput {
  id?: string
  city: 'taipei' | 'new-taipei'
  district: string
  address: string
  latitude: number
  longitude: number
  totalPrice: number
  areaPing: number
  age: number
  floor: number
  totalFloors: number
  buildingType: BuildingType
  hasParking: boolean
  parkingPrice: number
  radius: 300 | 500 | 1000
}

export interface Transaction {
  id: string
  date: string
  latitude: number
  longitude: number
  totalPrice: number
  areaPing: number
  age: number
  buildingType: BuildingType
  floor: number
  specialTransaction: boolean
  parkingPrice?: number
}

export interface FacilityProperties {
  name: string
  category: 'metro' | 'rail' | 'bus' | 'school' | 'medical' | 'park' | 'market' | 'parking' | 'library'
  demo?: boolean
}

export interface AccidentProperties {
  date: string
  severity: string
  demo?: boolean
}

export type PointCollection<T> = FeatureCollection<Point, T>
export type RiskCollection = FeatureCollection<Polygon | MultiPolygon, {
  name: string
  level: Exclude<RiskLevel, 'unknown'>
  sourceType: 'demo' | 'official'
}>

export interface DistrictDataset {
  transactions: Transaction[]
  facilities: PointCollection<FacilityProperties>
  accidents: PointCollection<AccidentProperties>
  updatedAt: string
  isDemo: boolean
}

export interface PriceAnalysis {
  unitPrice: number
  median: number | null
  q1: number | null
  q3: number | null
  sampleCount: number
  differencePercent: number | null
  radiusUsed: number
  parkingExcluded: boolean
  insufficient: boolean
  trend: Array<{ year: number; median: number }>
}

export interface AnalysisResult {
  input: PropertyInput
  price: PriceAnalysis
  flood: RiskLevel
  liquefaction: RiskLevel
  nearestMetro: number | null
  nearestRail: number | null
  busCount: number
  facilityCount: number
  accidentCount: number
  completeness: number
  checklist: ChecklistItem[]
  updatedAt: string
  demo: boolean
}

export interface ChecklistItem {
  id: string
  text: string
  level: RiskLevel
  checked: boolean
  custom?: boolean
}

export interface SavedProperty {
  id: string
  savedAt: string
  label: string
  result: AnalysisResult
}
