import type { PropertyInput } from '../types'

export interface DistrictOption {
  value: string
  label: string
  center: readonly [number, number]
}

export const districtOptions: Record<PropertyInput['city'], readonly DistrictOption[]> = {
  taipei: [
    { value: 'zhongzheng', label: '中正區', center: [25.0324, 121.5199] },
    { value: 'datong', label: '大同區', center: [25.0634, 121.5130] },
    { value: 'zhongshan', label: '中山區', center: [25.0685, 121.5338] },
    { value: 'songshan', label: '松山區', center: [25.0597, 121.5578] },
    { value: 'daan', label: '大安區', center: [25.0268, 121.5434] },
    { value: 'wanhua', label: '萬華區', center: [25.0319, 121.4993] },
    { value: 'xinyi', label: '信義區', center: [25.0337, 121.5650] },
    { value: 'shilin', label: '士林區', center: [25.0950, 121.5246] },
    { value: 'beitou', label: '北投區', center: [25.1326, 121.5010] },
    { value: 'neihu', label: '內湖區', center: [25.0830, 121.5880] },
    { value: 'nangang', label: '南港區', center: [25.0554, 121.6068] },
    { value: 'wenshan', label: '文山區', center: [24.9898, 121.5705] },
  ],
  'new-taipei': [
    { value: 'banqiao', label: '板橋區', center: [25.0114, 121.4618] },
    { value: 'sanchong', label: '三重區', center: [25.0615, 121.4881] },
    { value: 'zhonghe', label: '中和區', center: [24.9986, 121.5007] },
    { value: 'yonghe', label: '永和區', center: [25.0081, 121.5168] },
    { value: 'xinzhuang', label: '新莊區', center: [25.0358, 121.4500] },
    { value: 'xindian', label: '新店區', center: [24.9676, 121.5415] },
    { value: 'tucheng', label: '土城區', center: [24.9722, 121.4433] },
    { value: 'luzhou', label: '蘆洲區', center: [25.0849, 121.4738] },
    { value: 'shulin', label: '樹林區', center: [24.9907, 121.4205] },
    { value: 'yingge', label: '鶯歌區', center: [24.9566, 121.3543] },
    { value: 'sanxia', label: '三峽區', center: [24.9343, 121.3690] },
    { value: 'tamsui', label: '淡水區', center: [25.1676, 121.4450] },
    { value: 'xizhi', label: '汐止區', center: [25.0642, 121.6588] },
    { value: 'ruifang', label: '瑞芳區', center: [25.1089, 121.8107] },
    { value: 'wugu', label: '五股區', center: [25.0845, 121.4381] },
    { value: 'taishan', label: '泰山區', center: [25.0589, 121.4308] },
    { value: 'linkou', label: '林口區', center: [25.0790, 121.3889] },
    { value: 'shenkeng', label: '深坑區', center: [25.0016, 121.6167] },
    { value: 'shiding', label: '石碇區', center: [24.9917, 121.6586] },
    { value: 'pinglin', label: '坪林區', center: [24.9381, 121.7112] },
    { value: 'sanzhi', label: '三芝區', center: [25.2580, 121.5019] },
    { value: 'shimen', label: '石門區', center: [25.2913, 121.5687] },
    { value: 'bali', label: '八里區', center: [25.1467, 121.3999] },
    { value: 'pingxi', label: '平溪區', center: [25.0261, 121.7384] },
    { value: 'shuangxi', label: '雙溪區', center: [25.0345, 121.8657] },
    { value: 'gongliao', label: '貢寮區', center: [25.0220, 121.9088] },
    { value: 'jinshan', label: '金山區', center: [25.2216, 121.6369] },
    { value: 'wanli', label: '萬里區', center: [25.1757, 121.6887] },
    { value: 'wulai', label: '烏來區', center: [24.8657, 121.5509] },
  ],
}

export const districtSlugByName = new Map(
  Object.entries(districtOptions).flatMap(([city, districts]) =>
    districts.map((district) => [`${city}:${district.label}`, district.value] as const),
  ),
)
