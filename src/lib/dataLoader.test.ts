import { describe, expect, it, vi } from 'vitest'
import { DataLoadError, loadDistrictData } from './dataLoader'

describe('資料載入錯誤', () => {
  it('HTTP 失敗時回傳可辨識的 DataLoadError', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    await expect(loadDistrictData('taipei', 'daan', fetcher)).rejects.toBeInstanceOf(DataLoadError)
  })
})
