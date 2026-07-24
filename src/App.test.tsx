import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App, { MethodsPage, PriceTrend } from './App'
import type { DataManifest, DataReadinessManifest } from './types'

vi.mock('./components/MapPanel', () => ({
  MapPicker: ({ onChange }: { onChange: (latitude: number, longitude: number) => void }) => (
    <button type="button" onClick={() => onChange(25.03, 121.54)}>確認測試位置</button>
  ),
  AnalysisMap: () => null,
}))

vi.mock('./lib/dataLoader', () => ({
  DataLoadError: class DataLoadError extends Error {},
  loadManifest: vi.fn().mockResolvedValue(null),
  loadReadiness: vi.fn().mockResolvedValue(null),
  loadDistrictData: vi.fn(),
  loadFloodScenario: vi.fn(),
}))

describe('查詢表單', () => {
  beforeEach(() => {
    window.location.hash = '#/check'
    window.localStorage.clear()
    window.scrollTo = vi.fn()
  })

  afterEach(cleanup)

  it('初始欄位為空且未確認位置時不能提交', () => {
    render(<App />)
    expect(screen.getByLabelText('地址或路段')).toHaveValue('')
    expect(screen.getByLabelText('開價或成交價（元）')).toHaveValue(null)
    expect(screen.getByRole('button', { name: '產生風險整理' })).toBeDisabled()
    expect(screen.getByText('尚未確認位置：請在地圖點一下')).toBeInTheDocument()
  })

  it('載入範例後持續標示範例模式並可提交', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '載入大安區範例' }))
    expect(screen.getByRole('status')).toHaveTextContent('目前使用示範資料')
    expect(screen.getByLabelText('地址或路段')).toHaveValue('和平東路二段')
    expect(screen.getByRole('button', { name: '產生風險整理' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('縣市'), { target: { value: 'new-taipei' } })
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '產生風險整理' })).toBeDisabled()
  })
})

describe('價格年度趨勢', () => {
  afterEach(cleanup)

  it('年度樣本少於 5 筆時顯示明確警示', () => {
    render(<PriceTrend trend={[
      { year: 2024, median: 500000, sampleCount: 4 },
      { year: 2025, median: 520000, sampleCount: 8 },
    ]} />)
    expect(screen.getByRole('note')).toHaveTextContent('2024 年少於 5 筆')
    expect(screen.getByRole('row', { name: /2024/ })).toHaveClass('low-sample')
  })
})

describe('資料候選準備度', () => {
  afterEach(cleanup)

  it('只在 unavailable 來源顯示最新候選檢查且不影響正式來源數', () => {
    const source = (id: 'market' | 'park', status: 'official' | 'unavailable') => ({
      id,
      status,
      version: null,
      updatedAt: null,
      attemptedAt: null,
      recordCount: 0,
      coverage: { cities: [], districts: [] },
      downloadUrl: '',
      sha256: null,
      matchingRate: null,
      excluded: {},
      lastAttempt: { status: 'not-run' as const, message: '尚未接入' },
      files: [],
    })
    const manifest: DataManifest = {
      schemaVersion: '2.0.0' as const,
      dataVersion: 'test',
      generatedAt: '2026-07-24T00:00:00.000Z',
      mode: 'production' as const,
      coverage: { cities: ['taipei', 'new-taipei'], districts: [], years: [] },
      sources: {
        market: source('market', 'unavailable'),
        park: source('park', 'official'),
      },
    }
    const readiness: DataReadinessManifest = {
      schemaVersion: '1.0.0' as const,
      generatedAt: '2026-07-24T00:00:00.000Z',
      sources: {
        market: {
          id: 'market' as const,
          status: 'blocked' as const,
          checkedAt: '2026-07-24T00:00:00.000Z',
          adapterVersion: 'market-v2',
          matchingRates: { taipei: 1, 'new-taipei': 0.787878, overall: 0.914634 },
          excluded: { unmatchedAddress: 7 },
          locationMethods: { 'address-index-exact': 67 },
          blockedReason: '新北定位率未達 95%',
        },
      },
    }
    render(<MethodsPage manifest={manifest} readiness={readiness} />)
    expect(screen.getByText('目前正式政府資料：1 項')).toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'market 最新候選檢查' }))
      .toHaveTextContent('臺北 100.00%、新北 78.79%、整體 91.46%')
    expect(screen.getByRole('note')).toHaveTextContent('不參與正式分析或正式來源計數')
  })
})
