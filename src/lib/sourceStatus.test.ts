import { describe, expect, it } from 'vitest'
import { sourceRecordCountText, sourceStatusText } from './sourceStatus'
import type { SourceState } from '../types'

function source(
  status: 'official' | 'unavailable',
  sampleCount?: number,
  requiredSampleCount?: number,
  auditStatus: 'passed' | 'pending' = 'pending',
) {
  const value: SourceState = {
    id: 'actual-price',
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
    lastAttempt: { status: 'not-run', message: '' },
    files: [],
    qualityGates: {
      manualAudit: {
        status: auditStatus,
        adapterVersion: 'price-v1',
        checkedAt: null,
        sampleCount,
        requiredSampleCount,
      },
    },
  }
  return value
}

describe('sourceStatusText', () => {
  it('顯示人工驗收進度', () => {
    expect(sourceStatusText(source('unavailable', 2, 20))).toBe(
      '等待人工驗收 2/20',
    )
  })

  it('正式來源不被 pending gate 覆蓋', () => {
    expect(sourceStatusText(source('official', 20, 20))).toBe('正式資料')
  })

  it('顯示已通過人工驗收但尚待正式發布', () => {
    expect(sourceStatusText(source('unavailable', 9, 9, 'passed'))).toBe(
      '人工驗收通過 9/9，等待正式發布',
    )
  })

  it('沒有來源時顯示尚未接入', () => {
    expect(sourceStatusText(undefined)).toBe('尚未接入')
  })
})

describe('sourceRecordCountText', () => {
  it('未接入來源不顯示為零筆', () => {
    expect(sourceRecordCountText(source('unavailable'))).toBe('資料不足')
  })

  it('正式來源顯示格式化筆數', () => {
    const value = source('official')
    value.recordCount = 1234
    expect(sourceRecordCountText(value)).toBe('1,234')
  })
})
