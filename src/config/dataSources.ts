import type { DataSourceId } from '../types'

export interface DataSource {
  id: DataSourceId
  name: string
  agency: string
  sourceUrl: string
  license: string
  refreshFrequency: string
  notes: string
}

export const dataSources: DataSource[] = [
  {
    id: 'actual-price',
    name: '不動產買賣實價登錄',
    agency: '內政部地政司',
    sourceUrl: 'https://data.gov.tw/dataset/25119',
    license: '政府資料開放授權條款第 1 版',
    refreshFrequency: '每月 2、12、22 日檢查',
    notes: '只納入可用官方門牌精確定位的雙北中古住宅；少於 5 筆不產生價差結論。',
  },
  {
    id: 'district-boundary',
    name: '鄉鎮市區行政區界',
    agency: '內政部國土測繪中心',
    sourceUrl: 'https://data.gov.tw/dataset/7441',
    license: '政府資料開放授權條款第 1 版',
    refreshFrequency: '每月檢查 metadata',
    notes: '只作雙北官方圖資裁切與涵蓋範圍驗證，不作土地權界判定。',
  },
  {
    id: 'flood',
    name: '淹水潛勢圖',
    agency: '經濟部水利署',
    sourceUrl: 'https://data.gov.tw/dataset/25766',
    license: '政府資料開放授權條款第 1 版',
    refreshFrequency: '每月檢查 metadata',
    notes: '保留降雨情境與深度級距；僅供區域防災參考，不能作為土地使用限制依據。',
  },
  {
    id: 'liquefaction',
    name: '土壤液化潛勢',
    agency: '中央地質主管機關／臺北市政府',
    sourceUrl: 'https://data.gov.tw/dataset/28691',
    license: '依各官方資料集授權',
    refreshFrequency: '每月檢查 metadata',
    notes: '區域性圖資，不代表個別基地或建物結構安全。',
  },
  {
    id: 'metro',
    name: '臺北捷運營運車站',
    agency: '臺北大眾捷運股份有限公司',
    sourceUrl: 'https://data.taipei/dataset/detail?id=1eefa68d-7c8d-491b-8e75-66a161947426',
    license: '公開資料',
    refreshFrequency: '每月檢查',
    notes: '顯示直線距離，不代表實際步行路徑。',
  },
  {
    id: 'rail',
    name: '臺鐵車站',
    agency: '交通部臺灣鐵路管理機關',
    sourceUrl: '',
    license: '待確認',
    refreshFrequency: '尚未接入',
    notes: '取得免金鑰且可驗證的官方完整來源前維持資料不足。',
  },
  {
    id: 'bus-taipei',
    name: '臺北市公車站位',
    agency: '臺北市政府',
    sourceUrl: '',
    license: '待確認',
    refreshFrequency: '尚未接入',
    notes: '既有公開 SHP 過舊，不拿舊資料冒充現況。',
  },
  {
    id: 'bus-new-taipei',
    name: '新北市公車站位',
    agency: '新北市政府交通局',
    sourceUrl: 'https://data.ntpc.gov.tw/datasets/34b402a8-53d9-483d-9406-24a682c2d6dc',
    license: '政府資料開放授權條款第 1 版',
    refreshFrequency: '每月建立靜態快照',
    notes: '依 stoplocationid 去重，同一實體站位只計一次。',
  },
  ...([
    ['school', '學校', '雙北市政府'],
    ['medical', '醫療院所', '雙北市政府'],
    ['park', '公園', '雙北市政府'],
    ['market', '市場', '雙北市政府'],
    ['parking', '停車場', '雙北市政府'],
    ['library', '圖書館', '雙北市政府'],
  ] as const).map(([id, name, agency]) => ({
    id,
    name,
    agency,
    sourceUrl: '',
    license: '待逐一確認官方資料集',
    refreshFrequency: '尚未接入',
    notes: '此類別獨立標示來源狀態；無法可靠定位的紀錄會排除。',
  })),
  {
    id: 'accidents',
    name: 'A1／A2 傷亡道路交通事故',
    agency: '內政部警政署',
    sourceUrl: 'https://data.gov.tw/dataset/177136',
    license: '政府資料開放授權條款第 1 版',
    refreshFrequency: '每月檢查 metadata',
    notes: '只發布事故日期、等級與座標；件數少不代表較安全。',
  },
]
