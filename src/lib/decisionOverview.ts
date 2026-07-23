import type { AnalysisResult, DataSourceId, SourceStatus } from '../types'

export type DecisionAvailability = 'official' | 'partial' | 'unavailable'
export type DecisionDimensionId = 'price' | 'hazards' | 'transport' | 'life'

export interface DecisionDimension {
  id: DecisionDimensionId
  label: string
  value: string
  availability: DecisionAvailability
}

export interface DecisionOverview {
  dimensions: DecisionDimension[]
  priorityActions: string[]
  dataGaps: string[]
}

const available = (status?: SourceStatus) => status === 'official' || status === 'stale'
const gapLabels: Partial<Record<DataSourceId, string>> = {
  'actual-price': '實價登錄目前無法判定',
  flood: '淹水圖資覆蓋不明',
  liquefaction: '土壤液化圖資覆蓋不明',
  metro: '捷運資料未接入',
  rail: '臺鐵資料未接入',
  'bus-taipei': '臺北市公車站位未接入',
  'bus-new-taipei': '新北市公車站位未接入',
  accidents: '交通事故資料未接入',
  medical: '醫院資料未接入',
  parking: '停車場資料未接入',
  school: '學校資料未接入',
  park: '公園綠地未達發布門檻',
  market: '傳統零售市場資料尚未接入',
  library: '圖書館資料未接入',
}

export function buildDecisionOverview(result: AnalysisResult): DecisionOverview {
  const busSource: DataSourceId = result.input.city === 'taipei' ? 'bus-taipei' : 'bus-new-taipei'
  const transportSources: DataSourceId[] = ['metro', 'rail', busSource, 'accidents']
  const lifeSources: DataSourceId[] = ['medical', 'parking', 'school', 'park', 'market', 'library']
  const transportCount = transportSources.filter((id) => available(result.sources[id]?.status)).length
  const lifeCount = lifeSources.filter((id) => available(result.sources[id]?.status)).length
  const hazardCount = [result.flood, result.liquefaction].filter((level) => level !== 'unknown').length
  const priceReady = available(result.sources['actual-price']?.status) && !result.price.insufficient
  const availabilityFor = (count: number, total: number): DecisionAvailability =>
    count === total ? 'official' : count > 0 ? 'partial' : 'unavailable'

  const checkedSources = ['actual-price', 'flood', 'liquefaction', ...transportSources, ...lifeSources] as DataSourceId[]
  const gaps = [...new Set(checkedSources
    .filter((id) => !available(result.sources[id]?.status))
    .map((id) => gapLabels[id])
    .filter((label): label is string => Boolean(label)))]
  if (result.flood === 'unknown' && available(result.sources.flood?.status)) gaps.push('淹水位置的模式覆蓋無法確認')
  if (result.liquefaction === 'unknown' && available(result.sources.liquefaction?.status)) gaps.push('液化位置的調查覆蓋無法確認')

  return {
    dimensions: [
      { id: 'price', label: '價格', value: priceReady ? `${result.price.sampleCount} 筆，可判定` : `${result.price.sampleCount} 筆，無法判定`, availability: priceReady ? 'official' : 'unavailable' },
      { id: 'hazards', label: '災害', value: `已知 ${hazardCount}/2 項`, availability: availabilityFor(hazardCount, 2) },
      { id: 'transport', label: '交通', value: `可用 ${transportCount}/4 來源`, availability: availabilityFor(transportCount, 4) },
      { id: 'life', label: '生活機能', value: `可用 ${lifeCount}/6 類`, availability: availabilityFor(lifeCount, 6) },
    ],
    priorityActions: result.checklist.filter((item) => !item.checked).slice(0, 3).map((item) => item.text),
    dataGaps: [...new Set(gaps)],
  }
}

export function formatTaiwanDate(value: string | null | undefined): string {
  if (!value) return '日期不明'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}
