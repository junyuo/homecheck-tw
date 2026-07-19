import type {
  AccidentProperties,
  DataManifest,
  DataSourceId,
  DistrictDataset,
  FacilityProperties,
  PointCollection,
  RiskCollection,
  RuntimeSourceState,
  SourceState,
  Transaction,
} from '../types'

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
    message: outsideCoverage ? '此行政區不在來源涵蓋範圍' : (source?.lastAttempt.message ?? '尚未接入'),
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
  const floodFiles = sourceFiles(manifest.sources.flood, `${prefix}risks/`, 'flood.geojson')
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
    liquefaction: liquefactions.values[0] ?? null,
    sources,
    updatedAt: successfulDates.at(-1) ?? manifest.generatedAt,
  }
}

export async function loadRiskLayers(
  city: string,
  district: string,
  fetcher: typeof fetch = fetch,
): Promise<{ flood: RiskCollection | null; liquefaction: RiskCollection | null }> {
  const dataset = await loadDistrictData(city, district, fetcher)
  return { flood: dataset.flood, liquefaction: dataset.liquefaction }
}
