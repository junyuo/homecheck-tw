import type { FeatureCollection, Point, Polygon, MultiPolygon } from 'geojson'

export type RiskLevel = 'low' | 'attention' | 'priority' | 'unknown'
export type BuildingType = 'apartment' | 'mansion' | 'highrise'
export type SourceStatus = 'official' | 'stale' | 'failed' | 'unavailable'
export type FloodScenarioId =
  | '6h-150'
  | '6h-250'
  | '6h-350'
  | '12h-200'
  | '12h-300'
  | '12h-400'
  | '24h-200'
  | '24h-350'
  | '24h-500'
  | '24h-650'
export type DataSourceId =
  | 'actual-price'
  | 'district-boundary'
  | 'flood'
  | 'liquefaction'
  | 'metro'
  | 'rail'
  | 'bus-taipei'
  | 'bus-new-taipei'
  | 'school'
  | 'medical'
  | 'park'
  | 'market'
  | 'parking'
  | 'library'
  | 'accidents'

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
  parkingAreaPing: number
  radius: 300 | 500 | 1000
  floodScenario: FloodScenarioId
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
  parkingAreaPing?: number
  unitPriceApproximate?: boolean
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
export interface RiskProperties {
  name: string
  level: Exclude<RiskLevel, 'unknown'>
  sourceType: 'official'
  officialCategory: string
  riskType: 'flood' | 'liquefaction'
  scenario?: string
  durationHours?: number
  rainfallMm?: number
  updatedAt: string
  coverageConfirmed?: boolean
}
export type RiskCollection = FeatureCollection<Polygon | MultiPolygon, RiskProperties>

export interface RiskFinding {
  level: RiskLevel
  officialCategory: string | null
  scenario: FloodScenarioId | null
  durationHours: number | null
  rainfallMm: number | null
  updatedAt: string | null
  coverageConfirmed: boolean
}

export interface SourceState {
  id: DataSourceId
  status: SourceStatus
  version: string | null
  updatedAt: string | null
  attemptedAt: string | null
  recordCount: number
  coverage: {
    cities: string[]
    districts: string[]
    years?: number[]
  }
  downloadUrl: string
  sha256: string | null
  matchingRate: number | null
  metadataCheckedAt?: string | null
  validUntil?: string | null
  qualityGates?: Record<string, {
    status: 'passed' | 'pending' | 'failed'
    adapterVersion: string
    checkedAt: string | null
    sampleCount?: number
    gdalVersion?: string
  }>
  excluded: Record<string, number>
  lastAttempt: {
    status: 'success' | 'failed' | 'not-run'
    message: string
  }
  files: string[]
  notes?: string
}

export interface DataManifest {
  schemaVersion: '2.0.0'
  dataVersion: string
  generatedAt: string
  mode: 'production'
  coverage: {
    cities: Array<'taipei' | 'new-taipei'>
    districts: string[]
    years: number[]
  }
  sources: Partial<Record<DataSourceId, SourceState>>
}

export interface RuntimeSourceState {
  status: SourceStatus
  updatedAt: string | null
  validUntil?: string | null
  message: string
}

export interface DistrictDataset {
  transactions: Transaction[]
  facilities: PointCollection<FacilityProperties>
  accidents: PointCollection<AccidentProperties>
  flood: RiskCollection | null
  floodScenario: FloodScenarioId
  availableFloodScenarios: FloodScenarioId[]
  liquefaction: RiskCollection | null
  sources: Partial<Record<DataSourceId, RuntimeSourceState>>
  updatedAt: string
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
  parkingApproximate: boolean
  insufficient: boolean
  trend: Array<{ year: number; median: number }>
}

export interface AnalysisResult {
  input: PropertyInput
  price: PriceAnalysis
  flood: RiskLevel
  floodDetail: RiskFinding
  liquefaction: RiskLevel
  liquefactionDetail: RiskFinding
  nearestMetro: number | null
  nearestRail: number | null
  busCount: number
  facilityCount: number
  accidentCount: number
  completeness: number
  checklist: ChecklistItem[]
  updatedAt: string
  dataQuality: 'official' | 'mixed' | 'unavailable' | 'historic-demo'
  sources: Partial<Record<DataSourceId, RuntimeSourceState>>
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
  historicDemo?: boolean
  riskSnapshotLegacy?: boolean
  result: AnalysisResult
}
