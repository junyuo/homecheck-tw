import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Copy,
  Database,
  Download,
  Home,
  Info,
  Landmark,
  MapPin,
  Menu,
  Printer,
  RefreshCw,
  Route,
  Save,
  ShieldCheck,
  TrainFront,
  Trash2,
  X,
} from 'lucide-react'
import { AnalysisMap, MapPicker } from './components/MapPanel'
import { dataSources } from './config/dataSources'
import { buildAnalysis } from './lib/analysis'
import { DataLoadError, loadDistrictData, loadRiskLayers } from './lib/dataLoader'
import { clearProperties, deleteProperty, loadSavedProperties, saveProperty } from './lib/storage'
import type {
  AnalysisResult,
  BuildingType,
  DistrictDataset,
  PropertyInput,
  RiskCollection,
  RiskLevel,
  SavedProperty,
} from './types'

type Page = 'home' | 'check' | 'results' | 'compare' | 'methods'

const districtOptions = {
  taipei: [
    { value: 'daan', label: '大安區', center: [25.033, 121.543] },
    { value: 'xinyi', label: '信義區', center: [25.0337, 121.565] },
  ],
  'new-taipei': [
    { value: 'banqiao', label: '板橋區', center: [25.012, 121.462] },
  ],
} as const

const initialInput: PropertyInput = {
  city: 'taipei',
  district: 'daan',
  address: '和平東路二段（Demo）',
  latitude: 25.0269,
  longitude: 121.5434,
  totalPrice: 26800000,
  areaPing: 36.8,
  age: 18,
  floor: 7,
  totalFloors: 12,
  buildingType: 'highrise',
  hasParking: true,
  parkingPrice: 2500000,
  radius: 500,
}

const routeFromHash = (): Page => {
  const value = window.location.hash.replace('#/', '') as Page
  return ['home', 'check', 'results', 'compare', 'methods'].includes(value) ? value : 'home'
}

const go = (page: Page) => {
  window.location.hash = `/${page}`
}

const currency = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  maximumFractionDigits: 0,
})

const compactCurrency = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

const levelMeta: Record<RiskLevel, { label: string; icon: typeof Check }> = {
  low: { label: '目前未發現顯著異常', icon: Check },
  attention: { label: '建議進一步確認', icon: AlertTriangle },
  priority: { label: '優先查證', icon: AlertTriangle },
  unknown: { label: '資料不足或無法判定', icon: CircleHelp },
}

function Badge({ level }: { level: RiskLevel }) {
  const Icon = levelMeta[level].icon
  return (
    <span className={`risk-badge risk-${level}`}>
      <Icon size={15} aria-hidden="true" />
      {levelMeta[level].label}
    </span>
  )
}

function DemoBanner() {
  return (
    <aside className="demo-banner" aria-label="Demo 資料提醒">
      <Info size={18} aria-hidden="true" />
      <span><strong>目前為功能 Demo。</strong> 交易、設施、事故與風險圖層不是正式政府資料，不可用於購屋決策。</span>
      <a href="#/methods">查看資料狀態</a>
    </aside>
  )
}

function Header({ page, savedCount }: { page: Page; savedCount: number }) {
  const [open, setOpen] = useState(false)
  const links: Array<{ page: Page; label: string }> = [
    { page: 'check', label: '開始查詢' },
    { page: 'compare', label: `比較清單${savedCount ? ` ${savedCount}` : ''}` },
    { page: 'methods', label: '資料與方法' },
  ]
  return (
    <header className="site-header">
      <a className="brand" href="#/home" aria-label="買房先冷靜首頁">
        <span className="brand-mark" aria-hidden="true"><Home size={18} /></span>
        <span>買房先冷靜</span>
      </a>
      <button className="menu-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="開啟導覽">
        {open ? <X /> : <Menu />}
      </button>
      <nav className={open ? 'nav-open' : ''} aria-label="主要導覽">
        {links.map((link) => (
          <a
            key={link.page}
            className={page === link.page ? 'active' : ''}
            href={`#/${link.page}`}
            onClick={() => setOpen(false)}
          >
            {link.label}
          </a>
        ))}
      </nav>
    </header>
  )
}

function Footer() {
  return (
    <footer>
      <div>
        <strong>買房先冷靜</strong>
        <p>喜歡可以，先把風險看完。</p>
      </div>
      <div className="footer-links">
        <a href="#/methods">資料與方法</a>
        <a href="#disclaimer">免責聲明</a>
        <a href="https://github.com/" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </footer>
  )
}

function HomePage() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><ShieldCheck size={16} /> 購屋前的第二次深呼吸</span>
          <h1>喜歡可以，<br /><em>先把風險看完。</em></h1>
          <p className="hero-lead">把價格、區域災害、交通環境與生活機能放在同一張檢查表上。不是替你決定，而是幫你知道下一個問題該問什麼。</p>
          <div className="hero-actions">
            <button className="button primary" onClick={() => go('check')}>
              開始冷靜一下 <ArrowRight size={18} />
            </button>
            <a className="text-link" href="#/methods">先看資料怎麼來 <ChevronRight size={16} /></a>
          </div>
          <p className="privacy-note"><ShieldCheck size={15} /> 地址與房屋資料只在你的瀏覽器中分析，不傳送到第三方分析服務。</p>
        </div>
        <div className="hero-visual" aria-label="四項購屋風險檢查示意">
          <div className="map-grid" aria-hidden="true" />
          <div className="location-pulse" aria-hidden="true"><MapPin /></div>
          <div className="floating-card card-price">
            <span className="mini-icon"><Landmark /></span>
            <div><small>價格合理性</small><strong>6 筆相似成交</strong></div>
            <Badge level="attention" />
          </div>
          <div className="floating-card card-risk">
            <span className="mini-icon green"><ShieldCheck /></span>
            <div><small>區域風險圖層</small><strong>逐項顯示依據</strong></div>
            <Badge level="unknown" />
          </div>
          <div className="floating-card card-life">
            <span className="mini-icon navy"><TrainFront /></span>
            <div><small>生活圈</small><strong>300m · 500m · 1km</strong></div>
          </div>
        </div>
      </section>

      <section className="trust-strip">
        <span>公開資料</span><span>不需登入</span><span>瀏覽器端分析</span><span>最多比較 3 間</span>
      </section>

      <section className="section">
        <div className="section-heading">
          <span className="eyebrow">四個面向，一次看清</span>
          <h2>總分很快，依據才有用。</h2>
          <p>每個結果都附上觀察事實、判斷範圍、資料日期、信心程度與下一步。</p>
        </div>
        <div className="feature-grid">
          {[
            { icon: Landmark, no: '01', title: '價格合理性', text: '比較附近相似物件的中位數、四分位數、樣本數與近五年趨勢。' },
            { icon: ShieldCheck, no: '02', title: '天然災害', text: '用區域公開圖資檢視淹水、液化等潛勢，不推論個別建物安全。' },
            { icon: Route, no: '03', title: '交通環境', text: '確認車站、公車、主要道路與事故點位，並切換生活圈範圍。' },
            { icon: Building2, no: '04', title: '生活機能', text: '整理學校、醫療、公園、市場、停車場與圖書館等公共設施。' },
          ].map((feature) => (
            <article className="feature-card" key={feature.no}>
              <span className="feature-number">{feature.no}</span>
              <feature.icon size={24} aria-hidden="true" />
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="how-section">
        <div>
          <span className="eyebrow">三步驟完成初查</span>
          <h2>把看屋時的「感覺不錯」，變成可以查證的問題。</h2>
        </div>
        <ol className="steps">
          <li><span>1</span><div><strong>填入物件條件</strong><p>輸入價格、坪數、屋齡與建物型態。</p></div></li>
          <li><span>2</span><div><strong>確認地圖位置</strong><p>直接點選實際位置，不依賴地址轉座標服務。</p></div></li>
          <li><span>3</span><div><strong>帶著清單去看屋</strong><p>逐項確認風險、列印問題，最多比較三間。</p></div></li>
        </ol>
      </section>

      <section className="disclaimer" id="disclaimer">
        <Info aria-hidden="true" />
        <div>
          <h2>先說清楚：這是初步整理，不是鑑定。</h2>
          <p>本網站依政府公開資料提供購屋前的初步資訊整理，內容不構成不動產鑑價、法律意見、工程鑑定、建物安全認證或投資建議。公開資料可能存在時間差、缺漏或定位誤差，重要決策仍應向主管機關、專業技師、估價師、地政士或其他專業人員查證。</p>
        </div>
      </section>
    </main>
  )
}

interface CheckPageProps {
  input: PropertyInput
  setInput: React.Dispatch<React.SetStateAction<PropertyInput>>
  onAnalyze: () => void
  loading: boolean
  error: string | null
}

function CheckPage({ input, setInput, onAnalyze, loading, error }: CheckPageProps) {
  const districts = districtOptions[input.city]
  const update = <K extends keyof PropertyInput>(key: K, value: PropertyInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }))
  const handleCity = (city: PropertyInput['city']) => {
    const first = districtOptions[city][0]
    setInput((current) => ({
      ...current,
      city,
      district: first.value,
      latitude: first.center[0],
      longitude: first.center[1],
    }))
  }

  return (
    <main>
      <DemoBanner />
      <section className="page-intro">
        <span className="eyebrow">建立你的物件檢查</span>
        <h1>先把基本條件放上桌。</h1>
        <p>第一版支援臺北市、新北市的中古公寓、華廈與住宅大樓。帶有「Demo」的結果不可視為真實資料。</p>
      </section>
      <form className="check-layout" onSubmit={(event) => { event.preventDefault(); onAnalyze() }}>
        <div className="form-stack">
          <section className="form-card">
            <div className="form-card-heading"><span>01</span><div><h2>位置</h2><p>地址只作顯示，分析以地圖座標為準。</p></div></div>
            <div className="field-grid">
              <label>縣市
                <select value={input.city} onChange={(event) => handleCity(event.target.value as PropertyInput['city'])}>
                  <option value="taipei">臺北市</option>
                  <option value="new-taipei">新北市</option>
                </select>
              </label>
              <label>行政區
                <select
                  value={input.district}
                  onChange={(event) => {
                    const item = districts.find((district) => district.value === event.target.value)!
                    setInput((current) => ({ ...current, district: item.value, latitude: item.center[0], longitude: item.center[1] }))
                  }}
                >
                  {districts.map((district) => <option key={district.value} value={district.value}>{district.label}</option>)}
                </select>
              </label>
              <label className="full">地址或路段
                <input required value={input.address} onChange={(event) => update('address', event.target.value)} placeholder="例：和平東路二段" />
              </label>
            </div>
            <MapPicker
              key={`${input.city}-${input.district}`}
              latitude={input.latitude}
              longitude={input.longitude}
              onChange={(latitude, longitude) => setInput((current) => ({ ...current, latitude, longitude }))}
            />
            <div className="coordinate-row"><span>已確認座標</span><code>{input.latitude.toFixed(5)}, {input.longitude.toFixed(5)}</code></div>
          </section>

          <section className="form-card">
            <div className="form-card-heading"><span>02</span><div><h2>價格與坪數</h2><p>輸入數字時請以總價與權狀總坪數為準。</p></div></div>
            <div className="field-grid">
              <label>開價或成交價（元）
                <input type="number" min="1" required value={input.totalPrice} onChange={(event) => update('totalPrice', Number(event.target.value))} />
              </label>
              <label>建物總坪數
                <input type="number" min="0.1" step="0.1" required value={input.areaPing} onChange={(event) => update('areaPing', Number(event.target.value))} />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={input.hasParking} onChange={(event) => update('hasParking', event.target.checked)} />
                此價格包含車位
              </label>
              <label>車位價格（元，選填）
                <input type="number" min="0" disabled={!input.hasParking} value={input.parkingPrice} onChange={(event) => update('parkingPrice', Number(event.target.value))} />
              </label>
            </div>
          </section>

          <section className="form-card">
            <div className="form-card-heading"><span>03</span><div><h2>建物條件</h2><p>用於篩選屋齡差距不超過 10 年的相似交易。</p></div></div>
            <div className="field-grid three">
              <label>屋齡（年）
                <input type="number" min="0" max="100" required value={input.age} onChange={(event) => update('age', Number(event.target.value))} />
              </label>
              <label>所在樓層
                <input type="number" min="1" required value={input.floor} onChange={(event) => update('floor', Number(event.target.value))} />
              </label>
              <label>總樓層
                <input type="number" min="1" required value={input.totalFloors} onChange={(event) => update('totalFloors', Number(event.target.value))} />
              </label>
              <label>建物型態
                <select value={input.buildingType} onChange={(event) => update('buildingType', event.target.value as BuildingType)}>
                  <option value="apartment">中古公寓</option>
                  <option value="mansion">華廈</option>
                  <option value="highrise">住宅大樓</option>
                </select>
              </label>
              <label>生活圈範圍
                <select value={input.radius} onChange={(event) => update('radius', Number(event.target.value) as PropertyInput['radius'])}>
                  <option value={300}>300 公尺</option>
                  <option value={500}>500 公尺</option>
                  <option value={1000}>1 公里</option>
                </select>
              </label>
            </div>
          </section>
          {error && (
            <div className="error-box" role="alert">
              <AlertTriangle />
              <div><strong>資料載入失敗</strong><p>{error}</p></div>
              <button type="button" className="button secondary" onClick={onAnalyze}><RefreshCw size={16} /> Retry</button>
            </div>
          )}
          <button className="button primary submit-button" disabled={loading}>
            {loading ? <><span className="spinner" /> 正在載入這個行政區的資料…</> : <>產生風險整理 <ArrowRight size={18} /></>}
          </button>
        </div>
        <aside className="form-aside">
          <strong>資料不會離開你的裝置</strong>
          <p>輸入內容只在這個瀏覽器分頁使用；只有你按下「保存比較」後，摘要才會存入 Local Storage。</p>
          <hr />
          <span>目前資料狀態</span>
          <Badge level="unknown" />
          <p>正式政府資料尚未接入，所有分析會清楚標示 Demo。</p>
        </aside>
      </form>
    </main>
  )
}

function formatDistance(value: number | null) {
  if (value === null) return '資料不足'
  return value >= 1000 ? `${(value / 1000).toFixed(1)} 公里` : `${Math.round(value)} 公尺`
}

function priceLevel(result: AnalysisResult): RiskLevel {
  if (result.demo) return 'unknown'
  if (result.price.insufficient) return 'unknown'
  const difference = result.price.differencePercent ?? 0
  if (difference > 20) return 'priority'
  if (difference > 8 || difference < -20) return 'attention'
  return 'low'
}

interface ResultCardProps {
  icon: typeof Landmark
  index: string
  title: string
  level: RiskLevel
  children: React.ReactNode
}

function ResultCard({ icon: Icon, index, title, level, children }: ResultCardProps) {
  return (
    <article className="result-card">
      <div className="result-card-head">
        <span className="result-icon"><Icon /></span>
        <div><small>{index}</small><h2>{title}</h2></div>
        <Badge level={level} />
      </div>
      {children}
    </article>
  )
}

interface ResultsPageProps {
  result: AnalysisResult | null
  setResult: React.Dispatch<React.SetStateAction<AnalysisResult | null>>
  dataset: DistrictDataset | null
  layers: { flood: RiskCollection; liquefaction: RiskCollection } | null
  onSave: () => void
  saveMessage: string | null
}

function ResultsPage({ result, setResult, dataset, layers, onSave, saveMessage }: ResultsPageProps) {
  const [custom, setCustom] = useState('')
  if (!result) {
    return (
      <main className="empty-page">
        <CircleHelp size={42} />
        <h1>還沒有分析結果</h1>
        <p>先填入物件條件並在地圖上確認位置。</p>
        <button className="button primary" onClick={() => go('check')}>開始查詢</button>
      </main>
    )
  }
  const priceStatus = priceLevel(result)
  const toggleChecklist = (id: string) => setResult((current) => current ? ({
    ...current,
    checklist: current.checklist.map((item) => item.id === id ? { ...item, checked: !item.checked } : item),
  }) : current)
  const addCustom = () => {
    if (!custom.trim()) return
    setResult((current) => current ? ({
      ...current,
      checklist: [...current.checklist, { id: crypto.randomUUID(), text: custom.trim(), level: 'unknown', checked: false, custom: true }],
    }) : current)
    setCustom('')
  }
  const checklistText = [
    `買房先冷靜｜${result.input.address}`,
    ...result.checklist.map((item) => `${item.checked ? '☑' : '☐'} ${item.text}`),
    '',
    '提醒：本清單為公開資料初步整理，不構成鑑價、法律或工程意見。',
  ].join('\n')
  const copyChecklist = async () => navigator.clipboard.writeText(checklistText)

  return (
    <main>
      <DemoBanner />
      <section className="result-summary">
        <div>
          <span className="eyebrow">你的購屋風險整理</span>
          <h1>{result.input.address}</h1>
          <p>{result.input.city === 'taipei' ? '臺北市' : '新北市'} · 分析座標 {result.input.latitude.toFixed(5)}, {result.input.longitude.toFixed(5)}</p>
        </div>
        <div className="summary-actions">
          <button className="button secondary" onClick={() => go('check')}>調整條件</button>
          <button className="button primary" onClick={onSave}><Save size={17} /> 保存比較</button>
          {saveMessage && <span className="save-message" role="status">{saveMessage}</span>}
        </div>
      </section>
      <section className="result-overview" aria-label="分析摘要">
        <div><small>物件總價</small><strong>{compactCurrency.format(result.input.totalPrice)}</strong></div>
        <div><small>換算單價</small><strong>{currency.format(result.price.unitPrice)}<em>/坪</em></strong></div>
        <div><small>比較樣本</small><strong>{result.price.sampleCount}<em>筆</em></strong></div>
        <div><small>資料完整度</small><strong>{result.completeness}<em>%</em></strong></div>
      </section>

      <section className="result-grid">
        <ResultCard icon={Landmark} index="01" title="價格合理性" level={priceStatus}>
          <div className="big-fact">
            <small>與附近相似物件中位數差異</small>
            <strong>{result.price.differencePercent === null ? '無法判定' : `${result.price.differencePercent > 0 ? '+' : ''}${result.price.differencePercent.toFixed(1)}%`}</strong>
          </div>
          <dl className="metrics">
            <div><dt>第 25 百分位</dt><dd>{result.price.q1 === null ? '資料不足' : `${currency.format(result.price.q1)}/坪`}</dd></div>
            <div><dt>成交中位數</dt><dd>{result.price.median === null ? '資料不足' : `${currency.format(result.price.median)}/坪`}</dd></div>
            <div><dt>第 75 百分位</dt><dd>{result.price.q3 === null ? '資料不足' : `${currency.format(result.price.q3)}/坪`}</dd></div>
            <div><dt>比較範圍</dt><dd>半徑 {result.price.radiusUsed >= 1000 ? '1 公里' : `${result.price.radiusUsed} 公尺`}</dd></div>
          </dl>
          <div className="evidence">
            <p><strong>觀察到的事實</strong>{result.price.insufficient ? `只有 ${result.price.sampleCount} 筆符合條件，未產生精確的價差結論。` : `排除特殊交易後有 ${result.price.sampleCount} 筆可比較樣本。`}</p>
            <p><strong>判斷依據</strong>同行政區、相近建物型態、屋齡差不超過 10 年；優先 500 公尺，不足則擴至 1 公里。{result.price.parkingExcluded ? '本物件與交易樣本皆盡可能排除車位價格。' : '未排除本物件車位價格。'}</p>
            <p><strong>資料信心</strong>{result.price.insufficient ? '低：樣本少於 5 筆。' : result.price.sampleCount < 10 ? '中低：樣本有限，仍需確認樓層、座向與裝潢差異。' : '中：仍非正式鑑價。'}</p>
            <p><strong>建議確認</strong>索取同社區近期成交、謄本、車位拆價及屋況資料。</p>
          </div>
        </ResultCard>

        <ResultCard icon={ShieldCheck} index="02" title="天然災害" level={result.flood === 'priority' || result.liquefaction === 'priority' ? 'priority' : result.flood === 'unknown' || result.liquefaction === 'unknown' ? 'unknown' : 'attention'}>
          <dl className="metrics">
            <div><dt>淹水潛勢</dt><dd><Badge level={result.flood} /></dd></div>
            <div><dt>土壤液化潛勢</dt><dd><Badge level={result.liquefaction} /></dd></div>
            <div><dt>活動斷層</dt><dd><Badge level="unknown" /></dd></div>
            <div><dt>坡地與歷史災害</dt><dd><Badge level="unknown" /></dd></div>
          </dl>
          <div className="evidence">
            <p><strong>觀察到的事實</strong>正式資料尚未接入。目前只用 Demo 多邊形驗證「點是否落在圖層內」；活動斷層、坡地與歷史點位也尚未接入。</p>
            <p><strong>空間範圍</strong>以使用者確認的單一座標與區域性圖層相交判斷。</p>
            <p><strong>資料信心</strong>低：非正式圖資，不可解讀為個別建物安全狀態。</p>
            <p><strong>建議確認</strong>查閱主管機關正式圖台，並確認基地地質調查、地質改良與建物結構資料。</p>
          </div>
        </ResultCard>

        <ResultCard icon={TrainFront} index="03" title="交通環境" level={result.demo ? 'unknown' : result.nearestMetro === null && result.nearestRail === null ? 'unknown' : result.accidentCount > 2 ? 'attention' : 'low'}>
          <dl className="metrics">
            <div><dt>最近捷運站</dt><dd>{formatDistance(result.nearestMetro)}</dd></div>
            <div><dt>最近火車站</dt><dd>{formatDistance(result.nearestRail)}</dd></div>
            <div><dt>生活圈內公車站</dt><dd>{result.busCount} 個 Demo 點位</dd></div>
            <div><dt>交通事故</dt><dd>{result.accidentCount} 個 Demo 點位</dd></div>
          </dl>
          <div className="evidence">
            <p><strong>查詢範圍</strong>以確認座標為中心，半徑 {result.input.radius >= 1000 ? '1 公里' : `${result.input.radius} 公尺`}。</p>
            <p><strong>觀察到的事實</strong>距離為直線距離，不等同步行路徑；主要道路資料尚未接入。</p>
            <p><strong>資料信心</strong>低：目前為 Demo 點位。</p>
            <p><strong>建議確認</strong>在平日尖峰與夜間實走，留意轉乘、噪音、人行空間與事故熱點。</p>
          </div>
        </ResultCard>

        <ResultCard icon={Building2} index="04" title="生活機能" level={result.demo ? 'unknown' : result.facilityCount ? 'low' : 'unknown'}>
          <div className="big-fact">
            <small>{result.input.radius >= 1000 ? '1 公里' : `${result.input.radius} 公尺`}生活圈內公共設施</small>
            <strong>{result.facilityCount}<em> 個 Demo 點位</em></strong>
          </div>
          <div className="evidence">
            <p><strong>涵蓋類型</strong>學校、醫療、公園、市場、停車場與圖書館；超商不在第一版政府開放資料範圍。</p>
            <p><strong>資料信心</strong>低：目前為 Demo 點位，沒有資料不代表附近沒有設施。</p>
            <p><strong>建議確認</strong>實際走訪日常採買、垃圾處理、醫療與停車動線，並留意營業時間。</p>
          </div>
        </ResultCard>
      </section>

      {dataset && layers && (
        <section className="section map-section">
          <div className="section-heading compact">
            <span className="eyebrow">圖層檢視</span>
            <h2>把點位放回地圖上看。</h2>
            <p>地圖以外的完整文字結果已列在上方；可個別開關設施與 Demo 風險圖層。</p>
          </div>
          <AnalysisMap latitude={result.input.latitude} longitude={result.input.longitude} dataset={dataset} flood={layers.flood} liquefaction={layers.liquefaction} />
        </section>
      )}

      <section className="checklist-section">
        <div className="checklist-heading">
          <div><span className="eyebrow"><ClipboardCheck size={16} /> 看屋時建議詢問</span><h2>把未確認的事，帶到現場問清楚。</h2></div>
          <div className="checklist-actions">
            <button className="button secondary" onClick={copyChecklist}><Copy size={16} /> 複製文字</button>
            <button className="button secondary" onClick={() => window.print()}><Printer size={16} /> 列印／匯出 PDF</button>
          </div>
        </div>
        <div className="checklist-list">
          {result.checklist.map((item) => (
            <label className={item.checked ? 'checked' : ''} key={item.id}>
              <input type="checkbox" checked={item.checked} onChange={() => toggleChecklist(item.id)} />
              <span>{item.text}</span>
              <Badge level={item.level} />
            </label>
          ))}
        </div>
        <div className="custom-item">
          <label htmlFor="custom-check">加入自訂事項</label>
          <div><input id="custom-check" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="例：確認垃圾集中處理時間" /><button className="button secondary" onClick={addCustom}>加入</button></div>
        </div>
      </section>
      <p className="data-footnote">資料更新時間：西元 {result.updatedAt} · 查詢範圍依各面向標示 · 所有 Demo 資料均不可作為購屋決策依據。</p>
    </main>
  )
}

function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function ComparePage({ saved, setSaved }: { saved: SavedProperty[]; setSaved: (items: SavedProperty[]) => void }) {
  if (!saved.length) {
    return (
      <main className="empty-page">
        <Building2 size={42} />
        <h1>比較清單還是空的</h1>
        <p>完成分析後可保存物件；所有內容只留在這個瀏覽器的 Local Storage。</p>
        <button className="button primary" onClick={() => go('check')}>建立第一間物件</button>
      </main>
    )
  }
  const remove = (id: string) => setSaved(deleteProperty(id))
  const clear = () => { clearProperties(); setSaved([]) }
  return (
    <main>
      <section className="page-intro compare-intro">
        <div><span className="eyebrow">最多三間，並排冷靜想</span><h1>房屋比較</h1><p>保存內容只存在這個裝置。清除瀏覽資料後將無法復原，也不會同步到雲端。</p></div>
        <div className="summary-actions">
          <button className="button secondary" onClick={() => downloadJson('homecheck-comparison.json', saved)}><Download size={16} /> 匯出比較</button>
          <button className="button danger" onClick={clear}><Trash2 size={16} /> 清空全部</button>
        </div>
      </section>
      <div className="privacy-callout"><ShieldCheck /><div><strong>Local Storage 隱私說明</strong><p>資料不會上傳伺服器；若使用共用電腦，離開前請清空比較清單。</p></div></div>
      <section className="compare-scroll" aria-label="房屋比較表">
        <table className="compare-table">
          <thead><tr><th scope="col">比較項目</th>{saved.map((item) => <th scope="col" key={item.id}>{item.label}<button aria-label={`刪除 ${item.label}`} onClick={() => remove(item.id)}><Trash2 size={16} /></button></th>)}</tr></thead>
          <tbody>
            {[
              ['總物件價格', (x: SavedProperty) => currency.format(x.result.input.totalPrice)],
              ['換算單價', (x: SavedProperty) => `${currency.format(x.result.price.unitPrice)}/坪`],
              ['與附近行情差異', (x: SavedProperty) => x.result.price.differencePercent === null ? '資料不足' : `${x.result.price.differencePercent.toFixed(1)}%`],
              ['價格樣本數', (x: SavedProperty) => `${x.result.price.sampleCount} 筆`],
              ['淹水潛勢', (x: SavedProperty) => levelMeta[x.result.flood].label],
              ['土壤液化潛勢', (x: SavedProperty) => levelMeta[x.result.liquefaction].label],
              ['捷運距離', (x: SavedProperty) => formatDistance(x.result.nearestMetro)],
              ['生活設施數量', (x: SavedProperty) => `${x.result.facilityCount} 個 Demo 點位`],
              ['交通事故狀況', (x: SavedProperty) => `${x.result.accidentCount} 個 Demo 點位`],
              ['待確認事項', (x: SavedProperty) => `${x.result.checklist.filter((item) => !item.checked).length} 項`],
              ['資料完整度', (x: SavedProperty) => `${x.result.completeness}%`],
            ].map(([label, render]) => (
              <tr key={label as string}><th scope="row">{label as string}</th>{saved.map((item) => <td key={item.id}>{(render as (x: SavedProperty) => string)(item)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </section>
      {saved.length < 3 && <button className="button primary add-property" onClick={() => go('check')}>加入另一間房屋 <ArrowRight size={17} /></button>}
    </main>
  )
}

function MethodsPage() {
  return (
    <main>
      <section className="page-intro methods-intro">
        <span className="eyebrow">透明比漂亮的分數重要</span>
        <h1>資料與方法</h1>
        <p>這裡列出每一個資料來源的接入狀態、授權、判斷規則與限制。灰色不是零風險，而是我們沒有足夠資料。</p>
      </section>
      <section className="method-status">
        <Database />
        <div><strong>目前正式政府資料：0 項</strong><p>所有可操作資料都是明確標示的 Demo，目的僅是驗證下載、分析與介面流程。</p></div>
      </section>
      <section className="source-list">
        {dataSources.map((source) => (
          <article className="source-card" key={source.id}>
            <div className="source-head"><div><span>{source.agency}</span><h2>{source.name}</h2></div><span className={`source-status ${source.status}`}>{source.status === 'official' ? '正式資料' : source.status === 'planned' ? '尚未接入' : 'Demo Adapter'}</span></div>
            <dl>
              <div><dt>原始網址</dt><dd><a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.sourceUrl}</a></dd></div>
              <div><dt>授權</dt><dd>{source.license}</dd></div>
              <div><dt>更新時間</dt><dd>{source.lastUpdated}</dd></div>
              <div><dt>更新頻率</dt><dd>{source.refreshFrequency}</dd></div>
              <div><dt>覆蓋範圍</dt><dd>{source.coverage}</dd></div>
              <div><dt>已知限制</dt><dd>{source.notes}</dd></div>
            </dl>
          </article>
        ))}
      </section>
      <section className="method-rules">
        <div className="section-heading compact"><span className="eyebrow">風險判斷規則</span><h2>不把資料不足包裝成精準答案。</h2></div>
        <div className="rules-grid">
          <article><h3>價格</h3><p>同行政區、同建物型態、屋齡差不超過 10 年，排除特殊交易。優先半徑 500 公尺，不足擴至 1 公里；少於 5 筆不計價差結論。</p></article>
          <article><h3>災害</h3><p>以確認座標與區域 GeoJSON 多邊形相交。只能描述區域潛勢，不可推論建物結構、基地工法或實際損害。</p></article>
          <article><h3>交通與設施</h3><p>以直線距離計算 300、500 公尺或 1 公里生活圈。直線距離不代表實際步行路徑、坡度或穿越障礙。</p></article>
          <article><h3>狀態與信心</h3><p>狀態同時用圖示、文字與色彩表達。缺少來源、樣本或覆蓋時顯示灰色「資料不足」，不顯示 0 分。</p></article>
        </div>
      </section>
      <section className="disclaimer" id="disclaimer">
        <Info />
        <div><h2>免責聲明</h2><p>本網站依政府公開資料提供購屋前的初步資訊整理，內容不構成不動產鑑價、法律意見、工程鑑定、建物安全認證或投資建議。公開資料可能存在時間差、缺漏或定位誤差，重要決策仍應向主管機關、專業技師、估價師、地政士或其他專業人員查證。</p></div>
      </section>
    </main>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>(routeFromHash)
  const [input, setInput] = useState<PropertyInput>(initialInput)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [dataset, setDataset] = useState<DistrictDataset | null>(null)
  const [layers, setLayers] = useState<{ flood: RiskCollection; liquefaction: RiskCollection } | null>(null)
  const [saved, setSaved] = useState<SavedProperty[]>(() => loadSavedProperties())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  useEffect(() => {
    const onHash = () => {
      setPage(routeFromHash())
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    window.addEventListener('hashchange', onHash)
    if (!window.location.hash) go('home')
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const analyze = async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextDataset, nextLayers] = await Promise.all([
        loadDistrictData(input.city, input.district),
        loadRiskLayers(),
      ])
      const nextResult = buildAnalysis(input, nextDataset, nextLayers.flood, nextLayers.liquefaction)
      setDataset(nextDataset)
      setLayers(nextLayers)
      setResult(nextResult)
      go('results')
    } catch (reason) {
      setError(reason instanceof DataLoadError ? `${reason.message}。請確認網路後重試；舊的比較清單不受影響。` : '發生未預期錯誤，請稍後再試。')
    } finally {
      setLoading(false)
    }
  }

  const save = () => {
    if (!result) return
    try {
      const district = districtOptions[result.input.city].find((item) => item.value === result.input.district)?.label ?? ''
      const next = saveProperty(result, `${district}｜${result.input.address}`)
      setSaved(next)
      setSaveMessage(`已保存（${next.length}/3）`)
    } catch (reason) {
      setSaveMessage(reason instanceof Error ? reason.message : '無法保存')
    }
    window.setTimeout(() => setSaveMessage(null), 3000)
  }

  let content = <MethodsPage />
  if (page === 'home') content = <HomePage />
  if (page === 'check') content = <CheckPage input={input} setInput={setInput} onAnalyze={analyze} loading={loading} error={error} />
  if (page === 'results') content = <ResultsPage result={result} setResult={setResult} dataset={dataset} layers={layers} onSave={save} saveMessage={saveMessage} />
  if (page === 'compare') content = <ComparePage saved={saved} setSaved={setSaved} />

  return (
    <div className="app-shell">
      <Header page={page} savedCount={saved.length} />
      {content}
      <Footer />
    </div>
  )
}
