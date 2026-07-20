import type { AnalysisResult, SavedProperty } from '../types'
import { DEFAULT_FLOOD_SCENARIO } from '../config/risks'

export const STORAGE_KEY = 'homecheck-tw:properties'
export const MAX_PROPERTIES = 3
export const STORAGE_SCHEMA_VERSION = 5

interface StorageEnvelope {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION
  properties: SavedProperty[]
}

function encode(properties: SavedProperty[]): string {
  return JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, properties } satisfies StorageEnvelope)
}

const emptyRiskFinding = {
  level: 'unknown' as const,
  officialCategory: null,
  scenario: null,
  durationHours: null,
  rainfallMm: null,
  updatedAt: null,
  coverageConfirmed: false,
}

function migrateLegacy(
  items: SavedProperty[],
  riskSnapshotLegacy = true,
  lifeSnapshotLegacy = true,
  communitySnapshotLegacy = true,
): SavedProperty[] {
  return items.map((item) => {
    const legacy = item.result as AnalysisResult & { demo?: boolean }
    return {
      ...item,
      historicDemo: legacy.demo === true || legacy.dataQuality === 'historic-demo',
      riskSnapshotLegacy: item.riskSnapshotLegacy ?? riskSnapshotLegacy,
      lifeSnapshotLegacy: item.lifeSnapshotLegacy ?? lifeSnapshotLegacy,
      communitySnapshotLegacy: item.communitySnapshotLegacy ?? communitySnapshotLegacy,
      result: {
        ...legacy,
        input: {
          ...legacy.input,
          floodScenario: legacy.input.floodScenario ?? DEFAULT_FLOOD_SCENARIO,
        },
        floodDetail: legacy.floodDetail ?? {
          ...emptyRiskFinding,
          scenario: DEFAULT_FLOOD_SCENARIO,
          durationHours: 24,
          rainfallMm: 500,
        },
        liquefactionDetail: legacy.liquefactionDetail ?? emptyRiskFinding,
        lifeFacilities: {
          medical: legacy.lifeFacilities?.medical ??
            { count: 0, nearestDistance: null, nearestName: null },
          parking: legacy.lifeFacilities?.parking ??
            { count: 0, nearestDistance: null, nearestName: null },
          school: legacy.lifeFacilities?.school ?? {
            count: 0,
            nearestDistance: null,
            nearestName: null,
            byLevel: { elementary: 0, junior: 0, senior: 0, special: 0 },
          },
          park: legacy.lifeFacilities?.park ?? {
            count: 0,
            nearestDistance: null,
            nearestName: null,
            nearestType: null,
          },
        },
        dataQuality: legacy.demo === true ? 'historic-demo' : (legacy.dataQuality ?? 'unavailable'),
        sources: legacy.sources ?? {},
      },
    }
  }).map(({ result, ...item }) => {
    const migrated = { ...result } as AnalysisResult & { demo?: boolean }
    delete migrated.demo
    return { ...item, result: migrated }
  })
}

export function loadSavedProperties(storage: Pick<Storage, 'getItem'> = localStorage): SavedProperty[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return migrateLegacy(parsed).slice(0, MAX_PROPERTIES)
    if (parsed?.schemaVersion === STORAGE_SCHEMA_VERSION && Array.isArray(parsed.properties)) {
      return parsed.properties.slice(0, MAX_PROPERTIES)
    }
    if (parsed?.schemaVersion === 4 && Array.isArray(parsed.properties)) {
      return migrateLegacy(parsed.properties, false, false, true).slice(0, MAX_PROPERTIES)
    }
    if (parsed?.schemaVersion === 3 && Array.isArray(parsed.properties)) {
      return migrateLegacy(parsed.properties, false, true, true).slice(0, MAX_PROPERTIES)
    }
    if (parsed?.schemaVersion === 2 && Array.isArray(parsed.properties)) {
      return migrateLegacy(parsed.properties).slice(0, MAX_PROPERTIES)
    }
    return []
  } catch {
    return []
  }
}

export function saveProperty(
  result: AnalysisResult,
  label: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): SavedProperty[] {
  const current = loadSavedProperties(storage)
  if (current.length >= MAX_PROPERTIES) throw new Error('最多只能保存三間房屋')
  const item: SavedProperty = {
    id: result.input.id ?? crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    label,
    result,
  }
  const next = [...current, item]
  storage.setItem(STORAGE_KEY, encode(next))
  return next
}

export function deleteProperty(
  id: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): SavedProperty[] {
  const next = loadSavedProperties(storage).filter((item) => item.id !== id)
  storage.setItem(STORAGE_KEY, encode(next))
  return next
}

export function clearProperties(storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(STORAGE_KEY, encode([]))
}
