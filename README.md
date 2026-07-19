# 買房先冷靜

> 喜歡可以，先把風險看完。

部署於 GitHub Pages 的雙北購屋風險初查網站。它把附近實價登錄、交通、生活機能及區域災害資料放在同一份查證清單；不提供正式鑑價、工程鑑定、法律或投資意見。

## 目前資料狀態

範圍涵蓋臺北市 12 區及新北市 29 區。Production loader 不載入 Demo，未接入來源一律顯示「資料不足」。

| 來源 | 狀態 | 說明 |
| --- | --- | --- |
| 內政部實價登錄 | official | 最近五年雙北中古公寓、華廈、住宅大樓；230,466 筆，官方門牌精確匹配率 99.40% |
| 臺北捷運車站 | official | 109 個營運車站靜態快照 |
| 新北公車站位 | official | 依 `stoplocationid` 去重後 2,339 個實體站位 |
| 臺北公車、臺鐵 | unavailable | 取得通過品質門檻的官方免金鑰來源前不補值 |
| 淹水、土壤液化 | unavailable | 尚未完成行政區裁切、情境與 topology 驗證 |
| 學校、醫療、公園、市場、停車場、圖書館 | unavailable | 每類來源獨立接入，不以單一成功類別代表全部 |
| A1／A2 事故 | unavailable | 尚未完成最近三個完整年度的去識別快照 |

最新機器可讀狀態以 [`public/data/manifest.json`](public/data/manifest.json) 和 [`public/data/health.json`](public/data/health.json) 為準。實價筆數與匹配率會隨官方更新而變動；上表是 2026-07-19 本機產出的快照。

## 分析規則

- 價格：同行政區、同建物型態、屋齡差不超過 10 年，排除特殊交易；先查 500 公尺，不足 5 筆再擴至 1 公里。少於 5 筆不產生精確價差。
- 車位：同時有車位價格與坪數時使用 `(總價－車位價)/(總坪數－車位坪數)`；缺車位坪數會標為近似值。
- 定位：交易只納入與雙北官方門牌精確匹配且座標合理的紀錄；多重歧義、無法匹配及範圍外資料排除。
- 距離：皆為直線距離，不代表步行時間或實際路徑。
- 來源：每個來源獨立為 `official`、`stale`、`failed` 或 `unavailable`；一個來源載入失敗不會拖垮其他結果。
- Local Storage：schema v2；舊 Demo 比較資料會遷移為「歷史 Demo」，不得與正式品質混用。

## 技術架構

- React 18、TypeScript、Vite 6
- Leaflet／React Leaflet、Turf
- `proj4`：只在資料腳本中將 EPSG:3826（TWD97 TM2）轉為 WGS84
- 純靜態 JSON／GeoJSON；無資料庫、SSR、API Key 或常駐後端
- GitHub Actions + GitHub Pages，base path `/homecheck-tw/`

## 本機開發與驗證

需求：Node.js 22、npm，以及系統 `unzip`。

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
├── taipei/{district}/
│   ├── transactions/{year}.json
│   └── facilities/{source}.geojson
└── new-taipei/{district}/
    ├── transactions/{year}.json
    └── facilities/{source}.geojson
```

交易以 `city/district/year` 切割；點位與未來風險圖層按行政區切割。單檔上限 5 MB。原始 ZIP／CSV 只放 `.data-cache/`，已由 Git 忽略。

Demo 僅保留在 `src/test/fixtures/`，production loader 不會引用。

## 更新資料

手動 dry run：

```bash
npm run update-data -- --source=price --dry-run
npm run update-data -- --source=transport --dry-run
```

正式更新：

```bash
npm run update-data -- --source=price
npm run update-data -- --source=transport
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

實價登錄自動門檻為整體匹配率至少 95%、有合格交易的各區至少 85%、41 區均有輸出、核心欄位及座標有效。另需人工各抽查臺北／新北至少 10 筆後，才算完成正式發布複核。

`.github/workflows/update-data.yml` 可選 source 及 `dryRun`，並於每月 2、12、22 日 08:17（臺灣時間）執行。Workflow 只提交 `public/data`。

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

上述政府來源依其公開授權條款使用。地圖底圖為 © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)。

## 已知限制

- 地址文字只供顯示；分析位置由使用者在地圖確認，不呼叫第三方 geocoder。
- 公開資料可能有時間差、缺漏、定位誤差或 schema 變動。
- 液化、淹水、生活設施與事故仍待逐階段接入；灰色不是零風險。
- 目前未提供活動斷層、坡地、歷史災害、主要道路、銀行鑑價、建物結構認證、會員或雲端同步。

## 免責聲明

本網站依政府公開資料提供購屋前的初步資訊整理，內容不構成不動產鑑價、法律意見、工程鑑定、建物安全認證或投資建議。重要決策仍應向主管機關、專業技師、估價師、地政士或其他專業人員查證。
