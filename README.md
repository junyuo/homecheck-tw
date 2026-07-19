# 買房先冷靜

> 喜歡可以，先把風險看完。

「買房先冷靜」是一個部署於 GitHub Pages 的台灣購屋風險初步查詢網站。網站把價格、區域性天然災害、交通環境與生活機能整理在同一個查證流程，協助使用者在買房前發現值得進一步確認的問題。

本專案不提供正式鑑價、法律意見、工程鑑定、建物安全認證或投資建議。

## 目前資料狀態

**目前正式政府資料為 0 項。Repository 內所有交易、設施、事故與災害圖層都是明確標示的 Demo。** Demo 資料是人造的小型樣本，只用於驗證資料介面、計算、錯誤處理與 UI，不代表任何真實地址、交易或風險狀態。

正式來源的 Registry 位於 `src/config/dataSources.ts`，網站的「資料與方法」頁也會逐項顯示接入狀態。

## 核心功能

- 物件條件輸入：縣市、行政區、地址顯示文字、價格、坪數、屋齡、樓層、型態與車位。
- 地圖位置確認：不使用需 API Key 的地址轉座標服務；使用者在 OpenStreetMap 底圖上點選實際座標。
- 價格合理性：換算單價、車位拆價、中位數、四分位數、樣本數、價差與近五年趨勢資料結構。
- 區域災害：淹水與土壤液化 GeoJSON Adapter；活動斷層、坡地及歷史災害尚未接入時顯示「資料不足」。
- 交通與生活機能：直線距離、300／500 公尺／1 公里生活圈、設施圖層開關。
- 看屋查證清單：依風險與資料不足排序，可勾選、自訂、複製、列印或以瀏覽器列印為 PDF。
- 房屋比較：最多三筆，只存在瀏覽器 Local Storage，可刪除、清空及匯出 JSON。
- 透明度：每個分析面向顯示事實、判斷依據、來源狀態、更新日期、空間範圍、信心與下一步。

## 網站截圖

視覺 QA 後的首頁截圖放在：

```text
docs/screenshots/home-desktop.jpg
docs/screenshots/home-mobile.jpg
```

## 技術架構

- React 18 + TypeScript
- Vite 6，固定 GitHub Pages base path `/homecheck-tw/`
- Leaflet／React Leaflet：地圖與圖層
- Turf：距離與點落在多邊形內的判斷
- Vitest：單元測試
- ESLint：靜態檢查
- GitHub Actions + GitHub Pages
- 純靜態 JSON／GeoJSON；無資料庫、無 SSR、無常駐後端、無 API Key

畫面採單頁 Hash 導覽（`#/home`、`#/check`、`#/results`、`#/compare`、`#/methods`），重新整理不會要求 Pages 提供額外路由。

## 本機啟動

需求：Node.js 22、npm。

```bash
npm install
npm run dev
```

Vite 預設會以 `/homecheck-tw/` 為 base。若只想在本機根路徑預覽，可暫時執行：

```bash
VITE_BASE_PATH=/ npm run dev
```

## 測試與 Production Build

```bash
npm run lint
npm run test
npm run build
```

Build 輸出位於 `dist/`。Production 預覽：

```bash
npm run build
npx vite preview
```

## GitHub Pages 部署

`.github/workflows/deploy.yml` 會在 `main` push 後：

1. 安裝固定 lockfile 依賴。
2. 執行 lint、unit tests 與 production build。
3. 上傳 `dist/` Pages artifact。
4. 使用 GitHub Pages 官方 Action 部署。

Repository 設定步驟：

1. 將 GitHub Repository 命名為 `homecheck-tw`，並把程式推送到 `main`。
2. 開啟 **Settings → Pages**。
3. 在 **Build and deployment → Source** 選擇 **GitHub Actions**。
4. 到 **Actions** 確認 `Deploy GitHub Pages` workflow 成功。
5. 網址通常為 `https://<帳號>.github.io/homecheck-tw/`。

若 Repository 名稱不同，請同步修改 `vite.config.ts` 的 `pagesBase`。

## 靜態資料目錄

資料依城市／行政區切割；使用者分析特定行政區時才下載該區四個檔案。風險圖層目前共用小型 GeoJSON，正式資料量增加後也應再按城市或圖磚切割。

```text
public/data/
├── manifest.json
├── taipei/
│   ├── daan/
│   │   ├── price-summary.json
│   │   ├── transactions.json
│   │   ├── accidents.json
│   │   └── facilities.geojson
│   └── xinyi/
├── new-taipei/
│   └── banqiao/
└── risks/
    ├── flood-demo.geojson
    └── liquefaction-demo.geojson
```

`manifest.json` 記錄 schema、資料版本、產生時間、Demo／正式模式、涵蓋範圍及各來源狀態。JSON／GeoJSON 是靜態資產，可使用 GitHub Pages／瀏覽器的 HTTP 快取；應以 `dataVersion` 管理資料更新。

## 資料更新流程

`scripts/update-data.mjs` 提供最多三次有界重試與 last-good 保護的更新框架，階段包含：

1. download：來源 adapter 下載至外部暫存目錄。
2. validate：驗證所有 JSON 可解析、GeoJSON 為 FeatureCollection、manifest 必要欄位存在。
3. normalize：統一日期、座標、金額、建物型態與來源欄位。
4. filter：只保留臺北市／新北市、MVP 建物型態與最近五年資料。
5. aggregate：依行政區產生摘要與價格統計所需資料。
6. split：輸出 `city/district` 小檔案。
7. generate manifest：更新版本、來源及時間。
8. build：資料通過驗證後才建置網站。
9. deploy：Build 成功後由 Pages workflow 部署。

目前沒有設定正式下載 adapter，因此：

```bash
npm run update-data
```

只會驗證現有 last-good Demo 並 no-op，不會覆蓋資料。這是刻意的安全行為。

要測試一份已正規化的候選資料：

```bash
DATA_INPUT_DIR=/absolute/path/to/normalized-data npm run update-data
```

Script 先複製到 `.data-staging` 並完整驗證，成功才原子替換 `public/data`；失敗會刪除 staging 並保留上一版可用資料。`.github/workflows/update-data.yml` 支援手動觸發與每月排程，目前同樣只做 no-op 驗證，直到正式 adapter 加入。

## 正式資料接入方式

1. 逐一確認主管機關的穩定下載端點、欄位說明、授權與更新頻率；不要從互動圖台猜測內部 API。
2. 為每個來源建立獨立 adapter，將原始資料寫到 workflow 的暫存目錄，不直接寫入 `public/data`。
3. 實價登錄需標準化總價、車位價、坪數、交易日期、座標／行政區、建物型態、屋齡、樓層及特殊交易標記。
4. 設施與事故輸出 WGS84 `FeatureCollection<Point>`；風險圖資輸出 `Polygon`／`MultiPolygon`。
5. 在 `manifest.json` 將個別來源改為 `official`，並填入實際版本、更新日期與覆蓋範圍。
6. 同步更新 `src/config/dataSources.ts` 的 agency、sourceUrl、license、lastUpdated、coverage、status 與清理限制。
7. 移除或重新命名 `*-demo.geojson`，確保正式資料與 Demo 不會混在同一個檔案。
8. 執行 `npm run update-data`、`npm run test`、`npm run build`，人工抽查數筆來源與地圖位置後才發布。

建議優先從可穩定下載且授權明確的內政部實價登錄開始；災害圖資必須保持「區域性初步判讀」措辭。

## 資料授權與 Attribution

- 地圖底圖：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，Attribution 已顯示在地圖上。
- 政府資料：預計依各原始資料集適用的「政府資料開放授權條款」或個別使用規範，正式接入前需逐項確認。
- Demo：本 Repository 自建測試資料，禁止描述為政府發布或真實紀錄。

## 無障礙與隱私

- 表單欄位都有可見 Label，主要互動可用鍵盤操作。
- 狀態同時使用文字、圖示、邊框與顏色，不只靠顏色。
- 地圖以外有完整文字結果。
- 375px 版面避免橫向溢出；比較表在自己的可捲動區域內。
- 資料錯誤顯示原因與 Retry；無資料顯示「資料不足」而非 0 分。
- 使用者輸入不傳送到第三方分析服務；只有 OSM 圖磚請求會送出地圖視窗範圍相關的網路請求。
- Local Storage 只在使用者主動保存比較時使用。

## 已知限制

- 所有分析資料目前皆為 Demo，不可用於真實購屋判斷。
- 只提供大安、信義與板橋三個行政區的 Demo 檔案；架構支援後續擴充臺北市與新北市。
- 只支援中古公寓、華廈與住宅大樓的資料模型。
- 地址不自動轉座標，必須由使用者點選位置。
- 距離為直線距離，不是步行／駕車路徑。
- 活動斷層、坡地災害、歷史災害、主要道路與正式事故密度尚未接入。
- 沒有正式銀行鑑價、建物結構安全認證、會員、雲端同步或即時 AI。

## Roadmap

1. 接入並抽樣核對近五年臺北市／新北市實價登錄，建立可重現的特殊交易與車位拆價規則。
2. 接入授權明確、可版本化的淹水與土壤液化正式圖資，並將大型圖資按區切割。
3. 接入地方政府公共設施與交通事故資料，補上資料覆蓋率、更新監控及失敗告警。

## 免責聲明

本網站依政府公開資料提供購屋前的初步資訊整理，內容不構成不動產鑑價、法律意見、工程鑑定、建物安全認證或投資建議。公開資料可能存在時間差、缺漏或定位誤差，重要決策仍應向主管機關、專業技師、估價師、地政士或其他專業人員查證。
