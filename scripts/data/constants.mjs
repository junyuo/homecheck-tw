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
