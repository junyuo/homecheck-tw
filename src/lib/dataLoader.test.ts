import { describe, expect, it, vi } from 'vitest'
import { DataLoadError, loadDistrictData, loadReadiness } from './dataLoader'

describe('資料載入錯誤', () => {
  it('readiness 載入失敗時靜默回傳 null', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    await expect(loadReadiness(fetcher)).resolves.toBeNull()
  })

  it('readiness 不接受未知來源', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        schemaVersion: '1.0.0',
        generatedAt: '2026-07-24T00:00:00.000Z',
        sources: { unknown: {} },
      }),
    })
    await expect(loadReadiness(fetcher)).resolves.toBeNull()
  })

  it('HTTP 失敗時回傳可辨識的 DataLoadError', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    await expect(loadDistrictData('taipei', 'daan', fetcher)).rejects.toBeInstanceOf(DataLoadError)
  })

  it('單一設施來源失敗時仍保留價格資料', async () => {
    const source = (id: string, files: string[]) => ({
      id,
      status: 'official',
      version: 'test',
      updatedAt: '2026-07-19',
      attemptedAt: '2026-07-19',
      recordCount: 1,
      coverage: { cities: ['taipei'], districts: ['taipei/daan'] },
      downloadUrl: 'https://example.test',
      sha256: 'test',
      matchingRate: null,
      excluded: {},
      lastAttempt: { status: 'success', message: 'ok' },
      files,
    })
    const manifest = {
      schemaVersion: '2.0.0',
      dataVersion: 'test',
      generatedAt: '2026-07-19',
      mode: 'production',
      coverage: { cities: ['taipei'], districts: ['taipei/daan'], years: [2026] },
      sources: {
        'actual-price': source('actual-price', ['taipei/daan/transactions/2026.json']),
        metro: source('metro', ['taipei/daan/facilities/metro.geojson']),
      },
    }
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.endsWith('manifest.json')) return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => manifest,
      }
      if (url.endsWith('transactions/2026.json')) return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => [{
          id: '1', date: '2026-01-01', latitude: 25, longitude: 121.5,
          totalPrice: 10_000_000, areaPing: 20, age: 10, buildingType: 'highrise',
          floor: 3, specialTransaction: false,
        }],
      }
      return { ok: false, status: 503, headers: { get: () => 'application/json' } }
    }) as unknown as typeof fetch
    const dataset = await loadDistrictData('taipei', 'daan', fetcher)
    expect(dataset.transactions).toHaveLength(1)
    expect(dataset.facilities.features).toHaveLength(0)
    expect(dataset.sources.metro?.status).toBe('failed')
  })

  it('unavailable 候選檔不會被正式分析載入', async () => {
    const manifest = {
      schemaVersion: '2.0.0',
      dataVersion: 'test',
      generatedAt: '2026-07-19',
      mode: 'production',
      coverage: { cities: ['taipei'], districts: ['taipei/daan'], years: [2026] },
      sources: {
        'actual-price': {
          id: 'actual-price',
          status: 'unavailable',
          version: 'price-v1',
          updatedAt: '2026-07-19',
          attemptedAt: '2026-07-19',
          recordCount: 1,
          coverage: { cities: ['taipei'], districts: ['taipei/daan'] },
          downloadUrl: 'https://example.test',
          sha256: 'test',
          matchingRate: 1,
          excluded: {},
          lastAttempt: { status: 'success', message: '等待人工驗收' },
          files: ['taipei/daan/transactions/2026.json'],
        },
        flood: {
          id: 'flood',
          status: 'unavailable',
          version: 'risks-v1',
          updatedAt: '2026-07-19',
          attemptedAt: '2026-07-19',
          recordCount: 1,
          coverage: { cities: ['taipei'], districts: ['taipei/daan'] },
          downloadUrl: 'https://example.test',
          sha256: 'test',
          matchingRate: null,
          excluded: {},
          lastAttempt: { status: 'success', message: '等待人工驗收' },
          files: ['taipei/daan/risks/flood/24h-500.geojson'],
        },
      },
    }
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      if (String(request).endsWith('manifest.json')) return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => manifest,
      }
      throw new Error('unavailable 檔案不應被請求')
    }) as unknown as typeof fetch

    const dataset = await loadDistrictData('taipei', 'daan', fetcher)
    expect(dataset.transactions).toHaveLength(0)
    expect(dataset.flood).toBeNull()
    expect(dataset.availableFloodScenarios).toHaveLength(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('初始只載入指定淹水情境', async () => {
    const files = [
      'taipei/daan/risks/flood/6h-150.geojson',
      'taipei/daan/risks/flood/24h-500.geojson',
    ]
    const source = {
      id: 'flood',
      status: 'official',
      version: 'risks-v1',
      updatedAt: '2026-07-19',
      attemptedAt: '2026-07-19',
      recordCount: 2,
      coverage: { cities: ['taipei'], districts: ['taipei/daan'] },
      downloadUrl: 'https://example.test',
      sha256: 'test',
      matchingRate: null,
      excluded: {},
      lastAttempt: { status: 'success', message: 'ok' },
      files,
    }
    const manifest = {
      schemaVersion: '2.0.0',
      dataVersion: 'test',
      generatedAt: '2026-07-19',
      mode: 'production',
      coverage: { cities: ['taipei'], districts: ['taipei/daan'], years: [] },
      sources: { flood: source },
    }
    const emptyRisk = { type: 'FeatureCollection', features: [] }
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => String(request).endsWith('manifest.json') ? manifest : emptyRisk,
    }))
    const fetcher = fetchMock as unknown as typeof fetch

    const dataset = await loadDistrictData('taipei', 'daan', fetcher, '6h-150')
    expect(dataset.floodScenario).toBe('6h-150')
    expect(dataset.availableFloodScenarios).toEqual(['6h-150', '24h-500'])
    expect(fetchMock.mock.calls.some(([request]) =>
      String(request).includes('24h-500.geojson'))).toBe(false)
  })
})
