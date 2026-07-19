import { describe, expect, it, vi } from 'vitest'
import { DataLoadError, loadDistrictData } from './dataLoader'

describe('資料載入錯誤', () => {
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
})
