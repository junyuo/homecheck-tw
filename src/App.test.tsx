import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App, { PriceTrend } from './App'

vi.mock('./components/MapPanel', () => ({
  MapPicker: ({ onChange }: { onChange: (latitude: number, longitude: number) => void }) => (
    <button type="button" onClick={() => onChange(25.03, 121.54)}>確認測試位置</button>
  ),
  AnalysisMap: () => null,
}))

vi.mock('./lib/dataLoader', () => ({
  DataLoadError: class DataLoadError extends Error {},
  loadManifest: vi.fn().mockResolvedValue(null),
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
