export const DISTRICTS = {
  taipei: {
    中正區: 'zhongzheng',
    大同區: 'datong',
    中山區: 'zhongshan',
    松山區: 'songshan',
    大安區: 'daan',
    萬華區: 'wanhua',
    信義區: 'xinyi',
    士林區: 'shilin',
    北投區: 'beitou',
    內湖區: 'neihu',
    南港區: 'nangang',
    文山區: 'wenshan',
  },
  'new-taipei': {
    板橋區: 'banqiao',
    三重區: 'sanchong',
    中和區: 'zhonghe',
    永和區: 'yonghe',
    新莊區: 'xinzhuang',
    新店區: 'xindian',
    土城區: 'tucheng',
    蘆洲區: 'luzhou',
    樹林區: 'shulin',
    鶯歌區: 'yingge',
    三峽區: 'sanxia',
    淡水區: 'tamsui',
    汐止區: 'xizhi',
    瑞芳區: 'ruifang',
    五股區: 'wugu',
    泰山區: 'taishan',
    林口區: 'linkou',
    深坑區: 'shenkeng',
    石碇區: 'shiding',
    坪林區: 'pinglin',
    三芝區: 'sanzhi',
    石門區: 'shimen',
    八里區: 'bali',
    平溪區: 'pingxi',
    雙溪區: 'shuangxi',
    貢寮區: 'gongliao',
    金山區: 'jinshan',
    萬里區: 'wanli',
    烏來區: 'wulai',
  },
}

export const ALL_DISTRICTS = Object.entries(DISTRICTS).flatMap(([city, districts]) =>
  Object.entries(districts).map(([label, slug]) => ({ city, label, slug })))

export const SOURCE_URLS = {
  currentPrice: 'https://plvr.land.moi.gov.tw/opendata/lvr_landAcsv.zip',
  historicPrice: (season) =>
    `https://plvr.land.moi.gov.tw/DownloadSeason?season=${season}&type=zip&fileName=lvr_landcsv.zip`,
  taipeiAddress:
    'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=ce76ca0c-7f94-4935-ab47-1d2a41ca2abb',
  newTaipeiAddress:
    'https://data.ntpc.gov.tw/api/datasets/d7b568ab-3819-40c8-a6e7-a6b199443101/csv',
  metro:
    'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=c77e91bf-067c-475e-917b-545ff62b7d76',
  newTaipeiBus:
    'https://data.ntpc.gov.tw/api/datasets/34b402a8-53d9-483d-9406-24a682c2d6dc/csv',
  rail:
    'https://ods.railway.gov.tw/tra-ods-web/ods/download/dataResource/0518b833e8964d53bfea3f7691aea0ee',
  taipeiParking:
    'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json',
  newTaipeiParking:
    'https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/csv',
  taipeiHospital:
    'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=eab7fdff-574d-427b-9324-c00833d695c8',
  newTaipeiHospital:
    'https://data.ntpc.gov.tw/api/datasets/85bfcaa8-9932-4d06-a2ec-731171191883/csv/file',
  elementarySchool: 'https://stats.moe.gov.tw/files/school/114/e1_new.json',
  juniorSchool: 'https://stats.moe.gov.tw/files/opendata/j1_new.json',
  seniorSchool: 'https://stats.moe.gov.tw/files/school/114/high.json',
  specialSchool:
    'https://www.k12ea.gov.tw/files/common_unit/431a1ae5-9503-4675-8e59-07d7286be83f/doc/%E7%89%B9%E6%AE%8A%E6%95%99%E8%82%B2%E5%AD%B8%E6%A0%A1%E5%90%8D%E9%8C%84.csv',
  newTaipeiLandmarks:
    'https://data.ntpc.gov.tw/api/datasets/6dcff24a-838c-40fb-a9df-f1160afafe84/json?page=0&size=100000',
  publicLibraries: 'https://plisnet.nlpi.edu.tw/api/API/LibraryInfoData',
  taipeiPark: 'https://parks.taipei/parks/api/',
  newTaipeiPark:
    'https://data.ntpc.gov.tw/api/datasets/5fe3a136-29cc-4695-a17e-6636a32c3342/csv',
  taipeiPublicMarket:
    'https://data.taipei/api/dataset/89bebb3a-990d-4070-bd67-631a575f6d4a/resource/35acfce1-2c4d-4c70-aa75-601cdab2b3f7/download',
  taipeiPublicMarketStalls:
    'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=b0ef64c1-d920-44ba-8bfb-821456ce660b',
  taipeiPrivateMarket:
    'https://data.taipei/api/frontstage/tpeod/dataset/resource.download?rid=7f4cc85a-a956-4a93-bd7f-e9dd252bbb1c',
  newTaipeiMarket:
    'https://data.ntpc.gov.tw/api/datasets/785BE91A-CAAF-4E1C-91D6-F7D616D31A45/csv?page=0&size=100000',
  accidents: {
    2023: 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/E68DFD97-92B3-4A78-A447-87F1390B54B0/resource/C0876EEB-9468-4B23-8E67-AB57E3563A1B/download',
    2024: 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/CCAD7AA8-5139-4066-8BE3-D6CC3154C137/resource/36C1D864-51F8-4A78-9D68-8298E00B0732/download',
    2025: 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/FCD9C2D4-CB71-4EAA-AA4C-B088E5FE3157/resource/76BD5265-18D6-43F8-9C48-162DC7B01A1E/download',
  },
  districtBoundary:
    'https://www.tgos.tw/tgos/VirtualDir/Product/3fe61d4a-ca23-4f45-8aca-4a536f40f290/%E9%84%89%28%E9%8E%AE%E3%80%81%E5%B8%82%E3%80%81%E5%8D%80%29%E7%95%8C%E7%B7%9A1140318.zip',
  taipeiLiquefaction:
    'https://soil.taipei/Taipei2019/Main/pages/TPLiquid_84.GeoJSON',
  liquefaction: (classification) =>
    `https://www.geologycloud.tw/api/v1/zh-tw/liquefaction?area=${encodeURIComponent('臺北')}&classify=${encodeURIComponent(classification)}&all=true`,
  flood: (scenario) =>
    `https://gic.wra.gov.tw/gis/gic/API/Google/DownLoad.aspx?fname=flood_${scenario.replace('-', 'mm_')}&filetype=SHP`,
}

export const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] }

export const FLOOD_SCENARIOS = [
  { id: '6h-150', durationHours: 6, rainfallMm: 150 },
  { id: '6h-250', durationHours: 6, rainfallMm: 250 },
  { id: '6h-350', durationHours: 6, rainfallMm: 350 },
  { id: '12h-200', durationHours: 12, rainfallMm: 200 },
  { id: '12h-300', durationHours: 12, rainfallMm: 300 },
  { id: '12h-400', durationHours: 12, rainfallMm: 400 },
  { id: '24h-200', durationHours: 24, rainfallMm: 200 },
  { id: '24h-350', durationHours: 24, rainfallMm: 350 },
  { id: '24h-500', durationHours: 24, rainfallMm: 500 },
  { id: '24h-650', durationHours: 24, rainfallMm: 650 },
]

export const DEFAULT_FLOOD_SCENARIO = '24h-500'
