import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  csvFileRows,
  downloadFile,
  inTaipeiMetroArea,
  normalizeAddress,
  parseCsvLine,
  sha256,
  twd97ToWgs84,
  withRetry,
} from './core.mjs'
import { DISTRICTS, SOURCE_URLS } from './constants.mjs'

const TAIPEI_CODES = {
  中正區: '050', 大同區: '060', 中山區: '040', 松山區: '010', 大安區: '030', 萬華區: '070',
  信義區: '020', 士林區: '110', 北投區: '120', 內湖區: '100', 南港區: '090', 文山區: '080',
}

const NEW_TAIPEI_CODES = {
  板橋區: '010', 三重區: '020', 中和區: '030', 永和區: '040', 新莊區: '050', 新店區: '060',
  樹林區: '070', 鶯歌區: '080', 三峽區: '090', 淡水區: '100', 汐止區: '110', 瑞芳區: '120',
  土城區: '130', 蘆洲區: '140', 五股區: '150', 泰山區: '160', 林口區: '170', 深坑區: '180',
  石碇區: '190', 坪林區: '200', 三芝區: '210', 石門區: '220', 八里區: '230', 平溪區: '240',
  雙溪區: '250', 貢寮區: '260', 金山區: '270', 萬里區: '280', 烏來區: '290',
}

export function addressKey(district, address) {
  return `${district}|${address}`
}

const ADDRESS_DIGITS = { 零: '0', 〇: '0', 一: '1', 二: '2', 兩: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' }

function addressNumber(value) {
  if (!String(value).includes('十')) {
    return [...String(value)].map((digit) => ADDRESS_DIGITS[digit] ?? digit).join('')
  }
  const [tens, ones = ''] = String(value).split('十')
  return `${tens ? ADDRESS_DIGITS[tens] : '1'}${ones ? ADDRESS_DIGITS[ones] : '0'}`
}

function facilityAddressVariants(address, district) {
  const normalized = String(address).normalize('NFKC')
    .replace(new RegExp(`${district}[^路街大道]{1,8}里`), district)
  const numberNormalized = normalized
    .replace(/[零〇一二兩三四五六七八九十]+(?=[巷弄號之、．.,，])/g, addressNumber)
  const sectionNormalized = numberNormalized.replace(
    /([1-9])段/g,
    (match, value) => `${Object.keys(ADDRESS_DIGITS).find((key) => ADDRESS_DIGITS[key] === value && key !== '兩') ?? value}段`,
  )
  const firstAddress = sectionNormalized.replace(
    /([0-9]+(?:之[0-9]+)?)[、．.,，;；].*$/,
    '$1號',
  )
  return [String(address), normalized, numberNormalized, sectionNormalized, firstAddress]
}

export function matchAddress(index, address, city, district) {
  const cityLabel = city === 'taipei' ? '臺北市' : '新北市'
  const values = facilityAddressVariants(address, district)
    .map((value) => normalizeAddress(value, cityLabel, district))
    .filter(Boolean)
  const matches = [...new Set(values)]
    .map((value) => index.get(addressKey(district, value)))
    .filter((value) => value !== undefined)
  if (!matches.length) return { status: 'unmatched', coordinate: null }
  if (matches.some((value) => value === null)) return { status: 'ambiguous', coordinate: null }
  const coordinates = matches.filter(Boolean)
  const distinct = new Set(coordinates.map((coordinate) =>
    `${coordinate.longitude.toFixed(7)}:${coordinate.latitude.toFixed(7)}`))
  return distinct.size === 1
    ? { status: 'matched', coordinate: coordinates[0] }
    : { status: 'ambiguous', coordinate: null }
}

function addAddressCoordinate(index, key, coordinate) {
  if (!index.has(key)) {
    index.set(key, coordinate)
    return
  }
  const existing = index.get(key)
  if (existing === null) return
  const distanceMeters = Math.hypot(
    (existing.latitude - coordinate.latitude) * 111000,
    (existing.longitude - coordinate.longitude) * 101000,
  )
  if (distanceMeters > 100) index.set(key, null)
}

export async function buildTaipeiAddressIndex(cache, reuseCache = false) {
  const file = join(cache, 'taipei-address.csv')
  if (reuseCache) {
    await access(file).catch(() => downloadFile(SOURCE_URLS.taipeiAddress, file))
  } else {
    await downloadFile(SOURCE_URLS.taipeiAddress, file)
  }
  const index = new Map()
  let total = 0
  for await (const row of csvFileRows(file)) {
    const districtCode = String(row['鄉鎮市區代碼'] ?? '')
    const district = Object.keys(DISTRICTS.taipei)
      .find((name) => districtCode.endsWith(TAIPEI_CODES[name]))
    if (!district) continue
    const rawAddress = [
      row['街路段'], row['地區'], row['巷'], row['弄'], row['號'],
    ].filter(Boolean).join('')
    const normalized = normalizeAddress(rawAddress, '臺北市', district)
    const coordinate = twd97ToWgs84(row['橫座標'], row['縱座標'])
    if (!normalized || !coordinate || !inTaipeiMetroArea(coordinate)) continue
    addAddressCoordinate(index, addressKey(district, normalized), coordinate)
    total += 1
  }
  return { index, total, sha256: sha256(await readFile(file)) }
}

export async function buildNewTaipeiAddressIndex(cache, reuseCache = false) {
  const index = new Map()
  const pageSize = 100000
  let page = 0
  let total = 0
  const hashes = []
  while (true) {
    const url = `${SOURCE_URLS.newTaipeiAddress}?page=${page}&size=${pageSize}`
    const pageFile = join(cache, `new-taipei-address-${page}.csv`)
    const text = (reuseCache ? await readFile(pageFile, 'utf8').catch(() => null) : null)
      ?? await withRetry('new-taipei-address', async () => {
      const response = await fetch(url, { headers: { 'user-agent': 'homecheck-tw-data-pipeline/1.0' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.text()
      if (/^\s*</.test(value)) throw new Error('HTML response')
      await writeFile(pageFile, value)
      return value
    })
    hashes.push(text)
    const lines = text.split(/\r?\n/).filter(Boolean)
    const headers = parseCsvLine(lines.shift() ?? '').map((value) => value.replace(/^\uFEFF/, ''))
    for (const line of lines) {
      const values = parseCsvLine(line)
      const row = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']))
      const areaCode = String(row.areacode ?? '')
      const district = Object.keys(DISTRICTS['new-taipei'])
        .find((name) => areaCode.endsWith(NEW_TAIPEI_CODES[name]))
      if (!district) continue
      const rawAddress = [
        row['street、road、section'], row.area, row.lane, row.alley, row.number,
      ].filter(Boolean).join('')
      const normalized = normalizeAddress(rawAddress, '新北市', district)
      const coordinate = twd97ToWgs84(row.x_3826, row.y_3826)
      if (!normalized || !coordinate || !inTaipeiMetroArea(coordinate)) continue
      addAddressCoordinate(index, addressKey(district, normalized), coordinate)
      total += 1
    }
    if (lines.length < pageSize) break
    page += 1
    if (page > 30) throw new Error('新北門牌 API 分頁異常')
  }
  return { index, total, sha256: sha256(hashes.join('')) }
}
