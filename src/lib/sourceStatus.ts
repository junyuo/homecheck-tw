import type { DataManifest, DataSourceId, SourceStatus } from '../types'

const sourceStatusLabel: Record<SourceStatus, string> = {
  official: '正式資料',
  stale: '資料過期',
  failed: '最近更新失敗',
  unavailable: '尚未接入',
}

export function sourceStatusText(
  source: DataManifest['sources'][DataSourceId] | undefined,
) {
  if (source?.status === 'unavailable' && source.qualityGates?.manualAudit) {
    const gate = source.qualityGates.manualAudit
    if (gate.status === 'passed') {
      return gate.requiredSampleCount
        ? `人工驗收通過 ${gate.sampleCount ?? 0}/${gate.requiredSampleCount}，等待正式發布`
        : '人工驗收通過，等待正式發布'
    }
    if (gate.status !== 'pending') return '尚未接入'
    return gate.requiredSampleCount
      ? `等待人工驗收 ${gate.sampleCount ?? 0}/${gate.requiredSampleCount}`
      : '等待人工驗收'
  }

  return sourceStatusLabel[source?.status ?? 'unavailable']
}
