export type SourceStatus = 'official' | 'demo-adapter' | 'planned'

export interface DataSource {
  id: string
  name: string
  agency: string
  sourceUrl: string
  license: string
  lastUpdated: string
  refreshFrequency: string
  coverage: string
  status: SourceStatus
  notes: string
}

export const dataSources: DataSource[] = [
  {
    id: 'actual-price',
    name: '不動產實價登錄',
    agency: '內政部地政司',
    sourceUrl: 'https://lvr.land.moi.gov.tw/',
    license: '政府資料開放授權條款第 1 版',
    lastUpdated: '尚未接入正式快照',
    refreshFrequency: '預計每月',
    coverage: 'MVP 預計臺北市、新北市，近五年住宅交易',
    status: 'demo-adapter',
    notes: '目前交易資料為測試分析流程用的明確 Demo，不代表真實成交紀錄。',
  },
  {
    id: 'flood',
    name: '淹水潛勢圖',
    agency: '經濟部水利署',
    sourceUrl: 'https://data.gov.tw/',
    license: '依原始資料集授權條款',
    lastUpdated: '尚未接入',
    refreshFrequency: '依發布機關',
    coverage: '待正式圖資接入',
    status: 'demo-adapter',
    notes: 'GeoJSON Adapter 已完成；目前僅載入 Demo 多邊形以驗證介面。',
  },
  {
    id: 'liquefaction',
    name: '土壤液化潛勢',
    agency: '經濟部地質調查及礦業管理中心',
    sourceUrl: 'https://www.liquid.net.tw/',
    license: '依原始資料集使用規範',
    lastUpdated: '尚未接入',
    refreshFrequency: '依發布機關',
    coverage: '待正式圖資接入',
    status: 'demo-adapter',
    notes: '只能作區域性初步判讀，不可推論個別建物結構安全。',
  },
  {
    id: 'facilities',
    name: '公共設施與大眾運輸點位',
    agency: '各地方政府資料開放平台',
    sourceUrl: 'https://data.taipei/',
    license: '依各資料集授權條款',
    lastUpdated: '尚未接入',
    refreshFrequency: '預計每月',
    coverage: 'MVP 預計臺北市、新北市',
    status: 'demo-adapter',
    notes: '目前點位均明確標示 Demo；超商不在第一版資料範圍。',
  },
  {
    id: 'accidents',
    name: '道路交通事故資料',
    agency: '交通部道安資訊查詢網／政府資料開放平臺',
    sourceUrl: 'https://roadsafety.tw/',
    license: '依原始資料集授權條款',
    lastUpdated: '尚未接入',
    refreshFrequency: '預計每月',
    coverage: '待確認可穩定下載的公開資料',
    status: 'demo-adapter',
    notes: '目前為 Demo 點位；正式接入後應公布清理、去識別與密度計算方式。',
  },
  {
    id: 'fault-slope',
    name: '活動斷層、坡地災害與歷史災害點位',
    agency: '相關中央及地方主管機關',
    sourceUrl: 'https://data.gov.tw/',
    license: '待逐一確認',
    lastUpdated: '尚未接入',
    refreshFrequency: '待確認',
    coverage: '尚未接入',
    status: 'planned',
    notes: '介面顯示資料不足，不產生風險狀態。',
  },
]
