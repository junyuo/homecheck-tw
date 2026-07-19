import type { DistrictDataset, RiskCollection } from '../types'

const asset = (path: string) => `${import.meta.env.BASE_URL}data/${path}`

export class DataLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'DataLoadError'
  }
}

async function fetchJson<T>(path: string, fetcher: typeof fetch = fetch): Promise<T> {
  try {
    const response = await fetcher(asset(path))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as T
  } catch (error) {
    throw new DataLoadError(`無法載入 ${path}`, error)
  }
}

export async function loadDistrictData(
  city: string,
  district: string,
  fetcher: typeof fetch = fetch,
): Promise<DistrictDataset> {
  const prefix = `${city}/${district}`
  const [summary, transactions, facilities, accidents] = await Promise.all([
    fetchJson<{ updatedAt: string; mode: 'demo' | 'official' }>(`${prefix}/price-summary.json`, fetcher),
    fetchJson<DistrictDataset['transactions']>(`${prefix}/transactions.json`, fetcher),
    fetchJson<DistrictDataset['facilities']>(`${prefix}/facilities.geojson`, fetcher),
    fetchJson<DistrictDataset['accidents']>(`${prefix}/accidents.json`, fetcher),
  ])
  return {
    transactions,
    facilities,
    accidents,
    updatedAt: summary.updatedAt,
    isDemo: summary.mode === 'demo',
  }
}

export async function loadRiskLayers(fetcher: typeof fetch = fetch): Promise<{
  flood: RiskCollection
  liquefaction: RiskCollection
}> {
  const [flood, liquefaction] = await Promise.all([
    fetchJson<RiskCollection>('risks/flood-demo.geojson', fetcher),
    fetchJson<RiskCollection>('risks/liquefaction-demo.geojson', fetcher),
  ])
  return { flood, liquefaction }
}
