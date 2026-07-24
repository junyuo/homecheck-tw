import type {
  AccidentProperties,
  DataManifest,
  DataReadinessManifest,
  DataSourceId,
  DistrictDataset,
  FacilityProperties,
  FloodScenarioId,
  PointCollection,
  RiskCollection,
  RuntimeSourceState,
  SourceState,
  Transaction,
} from '../types'
import { DEFAULT_FLOOD_SCENARIO } from '../config/risks'

const asset = (path: string) => `${import.meta.env.BASE_URL}data/${path}`

export class DataLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'DataLoadError'
  }
}

async function fetchJson<T>(path: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(asset(path))
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const contentType = response.headers?.get?.('content-type') ?? ''
  if (contentType && !contentType.includes('json') && !contentType.includes('geo+json')) {
    throw new Error(`非 JSON 回應：${contentType}`)
  }
  return await response.json() as T
}

export async function loadManifest(fetcher: typeof fetch = fetch): Promise<DataManifest> {
  try {
    const manifest = await fetchJson<DataManifest>('manifest.json', fetcher)
    if (manifest.schemaVersion !== '2.0.0' || manifest.mode !== 'production') {
      throw new Error('不支援的資料契約')
    }
    return manifest
  } catch (error) {
    throw new DataLoadError('無法載入資料清單', error)
  }
}

export async function loadReadiness(
  fetcher: typeof fetch = fetch,
): Promise<DataReadinessManifest | null> {
  try {
    const readiness = await fetchJson<DataReadinessManifest>('readiness.json', fetcher)
    if (readiness.schemaVersion !== '1.0.0' ||
        !readiness.sources ||
        Object.keys(readiness.sources).some((id) => !['market', 'park'].includes(id))) {
      return null
    }
    return readiness
  } catch {
    return null
  }
}

const runtimeState = (
  source: SourceState | undefined,
  district: string,
): RuntimeSourceState => {
  const outsideCoverage = Boolean(
    source?.coverage.districts.length &&
    !source.coverage.districts.includes(district),
  )
  return {
    status: outsideCoverage ? 'unavailable' : (source?.status ?? 'unavailable'),
    updatedAt: outsideCoverage ? null : (source?.updatedAt ?? null),
    validUntil: outsideCoverage ? null : source?.validUntil,
    message: outsideCoverage ? '此行政區不在來源涵蓋範圍' : (source?.lastAttempt.message ?? '尚未接入'),
    years: outsideCoverage ? [] : source?.coverage.years,
  }
}

async function loadFiles<T>(
  files: string[],
  fetcher: typeof fetch,
): Promise<{ values: T[]; failed: string[] }> {
  const settled = await Promise.allSettled(files.map((file) => fetchJson<T>(file, fetcher)))
  return {
    values: settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []),
    failed: settled.flatMap((item, index) => item.status === 'rejected' ? [files[index]] : []),
  }
}

function sourceFiles(source: SourceState | undefined, prefix: string, suffix: string): string[] {
  if (!source || source.status === 'unavailable') return []
  return source?.files.filter((file) => file.startsWith(prefix) && file.endsWith(suffix)) ?? []
}

function markRuntimeFailure(
  sources: DistrictDataset['sources'],
  id: DataSourceId,
  failed: string[],
): void {
  if (!failed.length) return
  const current = sources[id] ?? { status: 'unavailable', updatedAt: null, message: '' }
  sources[id] = {
    ...current,
    status: 'failed',
    message: `部分檔案載入失敗：${failed.join('、')}`,
  }
}

export async function loadDistrictData(
  city: string,
  district: string,
  fetcher: typeof fetch = fetch,
  floodScenario: FloodScenarioId = DEFAULT_FLOOD_SCENARIO,
): Promise<DistrictDataset> {
  const manifest = await loadManifest(fetcher)
  const prefix = `${city}/${district}/`
  const sourceIds = Object.keys(manifest.sources) as DataSourceId[]
  const sources = Object.fromEntries(sourceIds.map((id) => [
    id,
    runtimeState(manifest.sources[id], `${city}/${district}`),
  ])) as DistrictDataset['sources']

  const priceSource = manifest.sources['actual-price']
  const priceFiles = sourceFiles(priceSource, `${prefix}transactions/`, '.json')
  const facilityIds: DataSourceId[] = [
    'metro', 'rail', 'bus-taipei', 'bus-new-taipei', 'school',
    'medical', 'park', 'market', 'parking', 'library',
  ]
  const facilityFiles = facilityIds.flatMap((id) =>
    sourceFiles(manifest.sources[id], `${prefix}facilities/`, '.geojson')
      .map((file) => ({ id, file })),
  )
  const accidentFiles = sourceFiles(manifest.sources.accidents, `${prefix}accidents/`, '.json')
  const floodPrefix = `${prefix}risks/flood/`
  const availableFloodScenarios = sourceFiles(
    manifest.sources.flood,
    floodPrefix,
    '.geojson',
  ).map((file) => file.slice(floodPrefix.length, -'.geojson'.length) as FloodScenarioId)
  const floodFiles = sourceFiles(
    manifest.sources.flood,
    floodPrefix,
    `/${floodScenario}.geojson`,
  )
  if (!floodFiles.length && availableFloodScenarios.includes(floodScenario)) {
    floodFiles.push(`${floodPrefix}${floodScenario}.geojson`)
  }
  const liquefactionFiles = sourceFiles(
    manifest.sources.liquefaction,
    `${prefix}risks/`,
    'liquefaction.geojson',
  )

  const [prices, facilities, accidents, floods, liquefactions] = await Promise.all([
    loadFiles<Transaction[]>(priceFiles, fetcher),
    Promise.allSettled(facilityFiles.map(({ file }) =>
      fetchJson<PointCollection<FacilityProperties>>(file, fetcher))),
    loadFiles<PointCollection<AccidentProperties>>(accidentFiles, fetcher),
    loadFiles<RiskCollection>(floodFiles, fetcher),
    loadFiles<RiskCollection>(liquefactionFiles, fetcher),
  ])

  markRuntimeFailure(sources, 'actual-price', prices.failed)
  markRuntimeFailure(sources, 'accidents', accidents.failed)
  markRuntimeFailure(sources, 'flood', floods.failed)
  markRuntimeFailure(sources, 'liquefaction', liquefactions.failed)
  facilityFiles.forEach(({ id, file }, index) => {
    if (facilities[index].status === 'rejected') markRuntimeFailure(sources, id, [file])
  })

  const facilityCollections = facilities.flatMap((item) =>
    item.status === 'fulfilled' ? [item.value] : [])
  const successfulDates = Object.values(sources)
    .flatMap((source) => source.updatedAt ? [source.updatedAt] : [])
    .sort()

  return {
    transactions: prices.values.flat(),
    facilities: {
      type: 'FeatureCollection',
      features: facilityCollections.flatMap((collection) => collection.features),
    },
    accidents: {
      type: 'FeatureCollection',
      features: accidents.values.flatMap((collection) => collection.features),
    },
    flood: floods.values[0] ?? null,
    floodScenario,
    availableFloodScenarios: [...new Set(availableFloodScenarios)],
    liquefaction: liquefactions.values[0] ?? null,
    sources,
    updatedAt: successfulDates.at(-1) ?? manifest.generatedAt,
  }
}

export async function loadRiskLayers(
  city: string,
  district: string,
  fetcher: typeof fetch = fetch,
  floodScenario: FloodScenarioId = DEFAULT_FLOOD_SCENARIO,
): Promise<{ flood: RiskCollection | null; liquefaction: RiskCollection | null }> {
  const dataset = await loadDistrictData(city, district, fetcher, floodScenario)
  return { flood: dataset.flood, liquefaction: dataset.liquefaction }
}

const floodCaches = new WeakMap<typeof fetch, Map<string, Promise<RiskCollection>>>()

export async function loadFloodScenario(
  city: string,
  district: string,
  scenario: FloodScenarioId,
  fetcher: typeof fetch = fetch,
): Promise<RiskCollection> {
  let cache = floodCaches.get(fetcher)
  if (!cache) {
    cache = new Map()
    floodCaches.set(fetcher, cache)
  }
  const key = `${city}/${district}/${scenario}`
  const cached = cache.get(key)
  if (cached) return cached
  const promise = loadManifest(fetcher).then((manifest) => {
    if (manifest.sources.flood?.status === 'unavailable') {
      throw new DataLoadError('淹水來源尚未通過發布閘門')
    }
    const expected = `${city}/${district}/risks/flood/${scenario}.geojson`
    if (!manifest.sources.flood?.files.includes(expected)) {
      throw new DataLoadError(`淹水情境 ${scenario} 尚未接入`)
    }
    return fetchJson<RiskCollection>(expected, fetcher)
  }).catch((error) => {
    cache?.delete(key)
    throw error
  })
  cache.set(key, promise)
  return promise
}
