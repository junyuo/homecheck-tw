# 買房先冷靜

> 喜歡可以，先把風險看完。

部署於 GitHub Pages 的雙北購屋風險初查網站。它把附近實價登錄、交通、生活機能及區域災害資料放在同一份查證清單；不提供正式鑑價、工程鑑定、法律或投資意見。

## 目前資料狀態

範圍涵蓋臺北市 12 區及新北市 29 區。Production loader 不載入 Demo，未接入來源一律顯示「資料不足」。

| 來源 | 狀態 | 說明 |
| --- | --- | --- |
| 內政部實價登錄 | official | 最近五年雙北中古公寓、華廈、住宅大樓；230,297 筆，門牌精確匹配率 99.40%；人工複核 20／20 通過，另有 7 筆 inconclusive 不計入 |
| 臺北捷運車站 | official | 109 個營運車站靜態快照 |
| 新北公車站位 | official | 依 `stoplocationid` 去重後 2,339 個實體站位 |
| 國土測繪中心行政區界 | official | 臺北 12 區、新北 29 區均已裁切 |
| 臺鐵車站 | official | 官方免金鑰 JSON 產生 29 個實體站、41 區檔案；9／9 人工抽查通過 |
| 臺北公車 | unavailable | 官方現有站位檔停留在 2021 年，不拿舊資料冒充現況 |
| 淹水、土壤液化 | official | 自動 QA 已通過；410 個淹水情境檔與 41 個液化檔，各完成臺北／新北 5 點官方 raw 原始分類複核 |
| 雙北路外公共停車場 | official | 2,607 個有汽車格位的靜態官方點位；20 筆設施稽核中的停車場 10／10 通過，不提供即時剩餘車位 |
| 雙北公私立醫院 | official | 64 個醫院點位；新北門牌精確匹配率 96.77%，設施稽核中的醫院 10／10 通過，不混入診所 |
| 雙北學校 | official | `community-v2` 產生 602 個校園點；臺北 96.40%、新北 100%、整體 98.39% 精確定位，雙北各 5 筆官方 raw 稽核通過 |
| 雙北公園綠地 | unavailable | 公園管線維持獨立；新北精確匹配率 86.08% 未達 95%，不發布候選 |
| 公立公共圖書館 | official | `library-v1` 依國立公共資訊圖書館官方經緯度產生 161 個雙北點位，雙北各 5 筆官方 raw 稽核通過 |
| 市場 | unavailable | 尚未完成雙北一致分類與定位驗收 |
| A1／A2 事故 | official | 2023–2025 雙北 218,122 件去識別事故；同案當事人列已合併，臺北／新北各 5 件官方 raw 離線驗收通過 |

最新機器可讀狀態以 [`public/data/manifest.json`](public/data/manifest.json) 和 [`public/data/health.json`](public/data/health.json) 為準。實價筆數與匹配率會隨官方更新而變動；上表是 2026-07-21 本機正式發布的快照。

## 分析規則

- 價格：同行政區、同建物型態、屋齡差不超過 10 年，排除特殊交易；先查 500 公尺，不足 5 筆再擴至 1 公里。少於 5 筆不產生精確價差。
- 車位：同時有車位價格與坪數時使用 `(總價－車位價)/(總坪數－車位坪數)`；缺車位坪數會標為近似值。
- 定位：交易只納入與雙北官方門牌精確匹配且座標合理的紀錄；多重歧義、無法匹配及範圍外資料排除。
- 距離：皆為直線距離，不代表步行時間或實際路徑。
- 臺鐵定位：官方地址與座標行政區需一致；邊界線精度差異僅容許 20 公尺，套用筆數會公開於 manifest（目前八斗子站 1 筆）。
- 淹水：預設為 24 小時 500 mm，可切換官方 10 種情境；0.3–0.5 m 為黃色、0.5 m 以上為紅色。
- 液化：官方低／中／高潛勢分別為綠／黃／紅；未確認模式或調查覆蓋的位置維持灰色。
- 災害圖資：只供區域性判讀，不代表個別建物安全。
- 生活機能：分別顯示生活圈內醫院、路外停車場、學校、公園綠地與公共圖書館數量及最近點位直線距離；學校距離不代表學區或入學資格，圖書館距離不代表藏書、開放時間或服務品質。
- 來源：每個來源獨立為 `official`、`stale`、`failed` 或 `unavailable`；一個來源載入失敗不會拖垮其他結果。
- Local Storage：schema v7；v6 事故明細保持有效，新增圖書館欄標示為舊快照；既有 v5–v2 與舊 Demo 仍依原規則遷移。

## 技術架構

- React 18、TypeScript、Vite 6
- Leaflet／React Leaflet、Turf
- `proj4`：只在資料腳本中將 EPSG:3826（TWD97 TM2）轉為 WGS84
- GDAL：只在資料建置與 CI 中解讀 SHP、確認 CRS、修復 geometry 及裁切行政區；不進入瀏覽器 bundle
- 純靜態 JSON／GeoJSON；無資料庫、SSR、API Key 或常駐後端
- GitHub Actions + GitHub Pages，base path `/homecheck-tw/`

## 本機開發與驗證

需求：Node.js 22、npm，以及系統 `unzip`。執行 `source=risks` 時另需 GDAL；macOS 可使用 `brew install gdal`，GitHub Actions 會按需安裝 `gdal-bin`。

```bash
npm install
npm run dev
```

```bash
npm run lint
npm test
npm run test:data
npm run validate:data
npm run build
```

## 資料契約

`manifest.json` 使用 schema v2，記錄每個來源的狀態、版本、更新及嘗試時間、筆數、涵蓋範圍、下載頁、雜湊、匹配率、排除原因、最近嘗試結果與實際檔案。

```text
public/data/
├── manifest.json
├── health.json
├── boundaries/{city}/{district}.geojson
├── taipei/{district}/
│   ├── transactions/{year}.json
│   ├── facilities/{source}.geojson
│   ├── accidents/{year}.json
│   └── risks/
│       ├── flood/{scenario}.geojson
│       └── liquefaction.geojson
└── new-taipei/{district}/
    ├── transactions/{year}.json
    ├── facilities/{source}.geojson
    ├── accidents/{year}.json
    └── risks/
        ├── flood/{scenario}.geojson
        └── liquefaction.geojson
```

交易以 `city/district/year` 切割；點位與未來風險圖層按行政區切割。單檔上限 5 MB。原始 ZIP／CSV 只放 `.data-cache/`，已由 Git 忽略。

Demo 僅保留在 `src/test/fixtures/`，production loader 不會引用。

人工稽核檔位於 `scripts/data/audits/`，只保存穩定 ID、城市、分類、欄位比對結果與時間；價格稽核不提交地址。候選樣本與官方 raw data 都位於 Git 忽略的 `.data-cache/`。

人工查核可中斷後續跑：

```bash
npm run audit:status
npm run audit:record -- --source=price --id=<id> --result=matched
npm run audit:record -- --source=price --id=<id> --result=inconclusive --attempts=2
npm run audit:record -- --source=price --id=<id> --result=mismatch --mismatch-fields=totalPrice,floor
npm run audit:record -- --source=flood --id=<id> --result=matched --observed=0.5-1.0
npm run audit:record -- --source=liquefaction --id=<id> --result=matched --observed=高潛勢
npm run audit:evidence -- --source=flood --id=<id>
npm run audit:evidence -- --source=flood --id=<id> --confirm
npm run audit:evidence -- --source=parking --id=<id>
npm run audit:evidence -- --source=medical --id=<id> --confirm
npm run audit:evidence -- --source=school --id=<id>
npm run audit:evidence -- --source=park --id=<id> --confirm
npm run audit:evidence -- --source=library --id=<id>
npm run audit:evidence -- --source=library --id=<id> --confirm
npm run audit:evidence -- --source=accidents --id=<id>
npm run audit:evidence -- --source=accidents --id=<id> --confirm
```

價格 `matched` 表示七個必要欄位已逐一一致；重做既有 ID 必須明確加上 `--replace`。`inconclusive` 至少需兩次查詢，CLI 會提示同城市、同建物型態的備援樣本。災害可人工填入官方圖台分類，或以 `audit:evidence` 直接查詢官方 raw SHP／GeoJSON；設施證據則比對名稱、ID、行政區、原始座標或門牌匹配結果，停車場另比對汽車格位。未加 `--confirm` 只預覽且不寫檔，來源雜湊或欄位不符均會阻擋。

## 更新資料

正式發布前依 [`docs/production-regression.md`](docs/production-regression.md) 驗收；尚未發布來源的查核證據與發布條件記錄於 [`docs/data-source-exploration.md`](docs/data-source-exploration.md)。

手動 dry run：

```bash
npm run update-data -- --source=price --dry-run
npm run update-data -- --source=risks --dry-run
npm run update-data -- --source=transport --dry-run
npm run update-data -- --source=facilities --dry-run
npm run update-data -- --source=accidents --dry-run
```

正式更新：

```bash
npm run update-data -- --source=price
npm run update-data -- --source=risks
npm run update-data -- --source=transport
npm run update-data -- --source=facilities
npm run update-data -- --source=accidents
```

支援的 scope 為 `all|price|risks|transport|facilities|accidents`。未完成的 adapter 只會保留 `unavailable`，不會產生替代資料。

每次更新預設重新下載官方檔案；只有除錯時明確設定 `REUSE_DATA_CACHE=true` 才會重用本機快取。

流程包含：

1. 最多三次有界重試，拒絕 HTTP 錯誤與 HTML 冒充資料檔。
2. 原始資料下載到 Git 忽略的快取。
3. 日期、坪數、建物型態、樓層、車位、特殊交易、地址及座標正規化。
4. schema、雙北座標、41 區、五年滾動窗口、重複 ID、匹配率及單檔大小驗證。
5. 候選資料先在 staging 產生；品質失敗保留 last-good，並更新 `health.json`。
6. 通過後才原子替換 `public/data`。

實價登錄自動門檻為整體匹配率至少 95%、有合格交易的各區至少 85%、41 區均有輸出、核心欄位及座標有效。每市會依穩定雜湊產生 10 筆主要樣本與 20 筆備援，主要樣本需涵蓋公寓、華廈、住宅大樓；官方查詢逾時或找不到可獨立核對紀錄時標為 `inconclusive`，改用同型態備援，不算通過。臺北／新北各 10 筆全部欄位一致後，才可由 `unavailable` 切換為 `official`。

災害 adapter 會驗證 10 種情境、CRS、雙北座標、面 geometry、未知深度比率、41 區檔案數及 5 MB 上限；淹水與液化各完成臺北／新北至少 5 個位置的官方 raw 原始分類複核後才切換為 `official`。證據保存 CRS、原始欄位、匹配數、來源與查詢摘要雜湊，不保存地址或完整 geometry；官方圖台恢復後再依來源、城市各抽一點交叉核對。

`facilities-v1` 會分別產生停車場與醫院各 41 個行政區 GeoJSON。`community-v2` 處理學校與公園綠地：學校先用完整門牌及保留里鄰的地址變體精確匹配，新北未匹配資料只接受行政區與校名完全一致的官方重要地標 TWD97 座標；公園仍維持獨立門檻。`library-v1` 使用全國公立公共圖書館官方經緯度，要求地址、行政區與座標一致。每類均有獨立 QA、稽核與 last-good，不能因其他設施失敗而連帶阻擋。

`accidents-v1` 以 `unzip -p` 串流解析 2023–2025 官方 A1／A2 ZIP，依案件層級欄位產生穩定 ID，合併同案多位當事人列。公開檔只保留 ID、日期、年度、A1／A2 與座標；三年共 123 個行政區／年度檔必須整體通過 QA 及雙北各 5 件離線證據才能發布。

完成稽核後，以發布工具只檢查並提升既有候選；它不下載或重建大型圖資，失敗不修改 last-good：

```bash
npm run audit:candidates
npm run audit:status
npm run release-data -- --source=price --dry-run
npm run release-data -- --source=risks --dry-run
npm run release-data -- --source=facilities --dry-run
npm run release-data -- --source=accidents --dry-run
npm run release-data -- --source=all
```

發布前會重新確認 adapter 版本、來源雜湊格式、manifest 內的當前候選檔雜湊、人工樣本數、零 mismatch、檔案清單及完整資料 QA。人工驗收只綁定 adapter 版本；只有解析、映射或座標邏輯變更才需要升版並重設稽核，日常來源更新仍由自動 QA 驗證，不要求重做全部人工抽查。

`.github/workflows/update-data.yml` 可選 source 及 `dryRun`。價格於每月 2、12、22 日 08:17、災害 metadata／雜湊於 3 日 09:17、交通於 4 日 09:17、設施於 5 日 09:17、事故於 6 日 09:17（臺灣時間）執行。Workflow 只提交 `public/data`。

## GitHub Pages

1. 到 Repository **Settings → Pages**。
2. **Build and deployment → Source** 選 **GitHub Actions**。
3. push `main` 後確認 `Deploy GitHub Pages` workflow。

Repository 若不叫 `homecheck-tw`，需同步修改 `vite.config.ts` 的 Pages base。

## 資料來源與授權

- [內政部本期實價登錄批次資料](https://data.gov.tw/dataset/25119)
- [臺北市門牌位置數值資料](https://data.gov.tw/dataset/155472)
- [新北市門牌位置數值資料](https://data.gov.tw/dataset/168887)
- [臺北捷運車站資料](https://data.taipei/dataset/detail?id=1eefa68d-7c8d-491b-8e75-66a161947426)
- [新北市公車站位](https://data.ntpc.gov.tw/datasets/34b402a8-53d9-483d-9406-24a682c2d6dc)
- [國營臺鐵車站基本資料](https://data.gov.tw/dataset/33425)
- [臺北市停車場資訊](https://data.taipei/dataset/detail?id=d5c0656b-5250-4179-a491-c94daa56ef2c)
- [新北市路外公共停車場資訊](https://data.ntpc.gov.tw/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68)
- [臺北市公私立醫院](https://data.taipei/dataset/detail?id=b02cd6b2-79be-4d7f-ae78-305b2af668f5)
- [新北市醫院地址清單](https://data.gov.tw/dataset/125639)
- [教育部國民小學名錄](https://data.gov.tw/dataset/6087)
- [教育部國民中學名錄](https://data.gov.tw/dataset/6088)
- [教育部一般高級中等學校名錄](https://data.gov.tw/dataset/6089)
- [教育部特殊教育學校名錄](https://data.gov.tw/dataset/6285)
- [新北市重要地標資訊](https://data.ntpc.gov.tw/datasets/6dcff24a-838c-40fb-a9df-f1160afafe84)
- [公共圖書館基本資料](https://data.gov.tw/dataset/99567)
- [臺北市公園基本資料](https://data.taipei/dataset/detail?id=ea732fb5-4bec-4be7-93f2-8ab91e74a6c6)
- [新北市公園](https://data.ntpc.gov.tw/datasets/5fe3a136-29cc-4695-a17e-6636a32c3342)
- [臺北市公車站位舊資料](https://data.taipei/dataset/detail?id=48aa5bca-2a4f-4fb7-a658-43cba51d5d56)
- [水利署淹水潛勢圖](https://data.gov.tw/dataset/25766)
- [臺北市土壤液化潛勢圖](https://data.taipei/dataset/detail?id=ec40e067-930f-4058-b7dc-71399d5f3147)
- [地質調查及礦業管理中心土壤液化圖資群組](https://data.gov.tw/dataset/28691)
- [國土測繪中心鄉鎮市區界線](https://data.gov.tw/dataset/7441)

上述政府來源依其公開授權條款使用。地圖底圖為 © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)。

## 已知限制

- 地址文字只供顯示；分析位置由使用者在地圖確認，不呼叫第三方 geocoder。
- 公開資料可能有時間差、缺漏、定位誤差或 schema 變動。
- 淹水與液化屬區域性潛勢圖資，灰色代表未確認覆蓋，不代表零風險；官方圖台恢復後仍需進行補充交叉抽查。
- 目前未提供活動斷層、坡地、歷史災害、主要道路、銀行鑑價、建物結構認證、會員或雲端同步。

## 免責聲明

本網站依政府公開資料提供購屋前的初步資訊整理，內容不構成不動產鑑價、法律意見、工程鑑定、建物安全認證或投資建議。重要決策仍應向主管機關、專業技師、估價師、地政士或其他專業人員查證。
