import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  calculateNormalizedUnitPrice,
  csvFileRows,
  csvRows,
  downloadFile,
  inTaipeiMetroArea,
  isSpecialTransaction,
  normalizeAddress,
  normalizeBuildingType,
  parseCsvLine,
  parseFloor,
  parseRocDate,
  sha256,
  sqmToPing,
  stableId,
  twd97ToWgs84,
  withRetry,
} from './core.mjs'
import { ALL_DISTRICTS, DISTRICTS, SOURCE_URLS } from './constants.mjs'

const FIVE_YEARS_MS = 5 * 365.25 * 24 * 60 * 60 * 1000

function seasonsSince(cutoff, now) {
  const seasons = []
  for (let year = cutoff.getUTCFullYear(); year <= now.getUTCFullYear(); year += 1) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      const endMonth = quarter * 3
      const quarterEnd = new Date(Date.UTC(year, endMonth, 0))
      if (quarterEnd < cutoff || quarterEnd >= now) continue
      seasons.push(`${year - 1911}S${quarter}`)
    }
  }
  return seasons
}

async function unzipRows(zipFile, entry) {
  const child = spawn('unzip', ['-p', zipFile, entry], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const rows = csvRows(child.stdout)
  return {
    rows,
    completion: new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`unzip ${entry}: ${stderr || code}`)))
    }),
  }
}

async function downloadArchives(cache, now, reuseCache) {
  const cutoff = new Date(now.getTime() - FIVE_YEARS_MS)
  const seasons = seasonsSince(cutoff, now)
  const archives = []
  for (const season of seasons) {
    const destination = join(cache, `${season}.zip`)
    if (reuseCache) {
      await access(destination).catch(() => downloadFile(SOURCE_URLS.historicPrice(season), destination))
    } else {
      await downloadFile(SOURCE_URLS.historicPrice(season), destination)
    }
    archives.push({ name: season, file: destination })
  }
  const current = join(cache, 'current.zip')
  if (reuseCache) {
    await access(current).catch(() => downloadFile(SOURCE_URLS.currentPrice, current))
  } else {
    await downloadFile(SOURCE_URLS.currentPrice, current)
  }
  archives.push({ name: 'current', file: current })
  return { archives, cutoff }
}

function addressKey(district, address) {
  return `${district}|${address}`
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
  // The official address files may give different entrances/floors of the same
  // house number slightly different points. Keep them only when the entire
  // difference is within one building-sized 100 m cluster.
  const sameLocation = distanceMeters <= 100
  if (!sameLocation) index.set(key, null)
}

async function buildTaipeiAddressIndex(cache, reuseCache) {
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
    const district = Object.keys(DISTRICTS.taipei).find((name) => districtCode.endsWith({
      中正區: '050', 大同區: '060', 中山區: '040', 松山區: '010', 大安區: '030', 萬華區: '070',
      信義區: '020', 士林區: '110', 北投區: '120', 內湖區: '100', 南港區: '090', 文山區: '080',
    }[name]))
    if (!district) continue
    const rawAddress = [
      row['街路段'], row['地區'], row['巷'], row['弄'], row['號'],
    ].filter(Boolean).join('')
    const normalized = normalizeAddress(rawAddress, '臺北市', district)
    const coordinate = twd97ToWgs84(row['橫座標'], row['縱座標'])
    if (!normalized || !coordinate || !inTaipeiMetroArea(coordinate)) continue
    const key = addressKey(district, normalized)
    addAddressCoordinate(index, key, coordinate)
    total += 1
  }
  return { index, total, sha256: sha256(await readFile(file)) }
}

async function buildNewTaipeiAddressIndex(cache, reuseCache) {
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
      const district = Object.keys(DISTRICTS['new-taipei']).find((name) =>
        areaCode.endsWith({
          板橋區: '010', 三重區: '020', 中和區: '030', 永和區: '040', 新莊區: '050', 新店區: '060',
          樹林區: '070', 鶯歌區: '080', 三峽區: '090', 淡水區: '100', 汐止區: '110', 瑞芳區: '120',
          土城區: '130', 蘆洲區: '140', 五股區: '150', 泰山區: '160', 林口區: '170', 深坑區: '180',
          石碇區: '190', 坪林區: '200', 三芝區: '210', 石門區: '220', 八里區: '230', 平溪區: '240',
          雙溪區: '250', 貢寮區: '260', 金山區: '270', 萬里區: '280', 烏來區: '290',
        }[name]))
      if (!district) continue
      const rawAddress = [
        row['street、road、section'], row.area, row.lane, row.alley, row.number,
      ].filter(Boolean).join('')
      const normalized = normalizeAddress(rawAddress, '新北市', district)
      const coordinate = twd97ToWgs84(row.x_3826, row.y_3826)
      if (!normalized || !coordinate || !inTaipeiMetroArea(coordinate)) continue
      const key = addressKey(district, normalized)
      addAddressCoordinate(index, key, coordinate)
      total += 1
    }
    if (lines.length < pageSize) break
    page += 1
    if (page > 30) throw new Error('新北門牌 API 分頁異常')
  }
  return { index, total, sha256: sha256(hashes.join('')) }
}

function parseSale(row, city, cutoff, addressIndex, stats) {
  const districtLabel = String(row.鄉鎮市區 ?? '').trim()
  const district = DISTRICTS[city][districtLabel]
  if (!district) return null
  stats[district].seen += 1
  if (!String(row.交易標的 ?? '').startsWith('房地(土地+建物)')) {
    stats[district].excluded.nonResidentialTarget += 1
    return null
  }
  const buildingType = normalizeBuildingType(row.建物型態)
  if (!buildingType || !String(row.主要用途 ?? '').includes('住家用')) {
    stats[district].excluded.unsupportedBuilding += 1
    return null
  }
  const date = parseRocDate(row.交易年月日)
  if (!date || new Date(`${date}T00:00:00Z`) < cutoff) {
    stats[district].excluded.outsideWindow += 1
    return null
  }
  const totalPrice = Number(row.總價元)
  const areaPing = sqmToPing(row.建物移轉總面積平方公尺)
  const completion = parseRocDate(row.建築完成年月)
  const age = completion
    ? Math.max(0, Math.floor((new Date(date) - new Date(completion)) / (365.25 * 24 * 60 * 60 * 1000)))
    : null
  if (!(totalPrice > 0) || !(areaPing > 0) || age === null || age > 200) {
    stats[district].excluded.invalidCoreFields += 1
    return null
  }
  stats[district].eligible += 1
  const normalizedAddress = normalizeAddress(row.土地位置建物門牌, city, districtLabel)
  const coordinate = addressIndex.get(addressKey(districtLabel, normalizedAddress))
  if (coordinate === null) {
    stats[district].excluded.ambiguousAddress += 1
    return null
  }
  if (!coordinate) {
    stats[district].excluded.unmatchedAddress += 1
    return null
  }
  if (!inTaipeiMetroArea(coordinate)) {
    stats[district].excluded.outOfBounds += 1
    return null
  }
  stats[district].matched += 1
  const parkingPrice = Math.max(0, Number(row.車位總價元) || 0)
  const parkingAreaPing = sqmToPing(row.車位移轉總面積平方公尺)
  return {
    district,
    transaction: {
      id: stableId([
        row.編號, date, districtLabel, normalizedAddress, totalPrice,
        row.建物移轉總面積平方公尺, row.移轉層次,
      ]),
      date,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      totalPrice,
      areaPing,
      age,
      buildingType,
      floor: parseFloor(row.移轉層次),
      specialTransaction: isSpecialTransaction(row.備註),
      parkingPrice,
      parkingAreaPing,
      unitPriceApproximate: parkingPrice > 0 && parkingAreaPing <= 0,
      unitPrice: calculateNormalizedUnitPrice(totalPrice, areaPing, parkingPrice, parkingAreaPing),
    },
  }
}

function makeStats(city) {
  return Object.fromEntries(Object.values(DISTRICTS[city]).map((district) => [district, {
    seen: 0,
    eligible: 0,
    matched: 0,
    excluded: {
      nonResidentialTarget: 0,
      unsupportedBuilding: 0,
      outsideWindow: 0,
      invalidCoreFields: 0,
      ambiguousAddress: 0,
      unmatchedAddress: 0,
      outOfBounds: 0,
    },
  }]))
}

async function processCity(city, archives, cutoff, addressIndex) {
  const transactions = new Map(Object.values(DISTRICTS[city]).map((district) => [district, new Map()]))
  const stats = makeStats(city)
  const entry = city === 'taipei' ? 'a_lvr_land_a.csv' : 'f_lvr_land_a.csv'
  for (const archive of archives) {
    const { rows, completion } = await unzipRows(archive.file, entry)
    for await (const row of rows) {
      const parsed = parseSale(row, city, cutoff, addressIndex, stats)
      if (parsed) transactions.get(parsed.district).set(parsed.transaction.id, parsed.transaction)
    }
    await completion
  }
  return { transactions, stats }
}

function qualityReport(cityResults) {
  const districts = Object.values(cityResults).flatMap((result) => Object.entries(result.stats))
  const totalEligible = districts.reduce((sum, [, stats]) => sum + stats.eligible, 0)
  const totalMatched = districts.reduce((sum, [, stats]) => sum + stats.matched, 0)
  const matchingRate = totalEligible ? totalMatched / totalEligible : 0
  const failedDistricts = districts
    .filter(([, stats]) => stats.eligible > 0 && stats.matched / stats.eligible < 0.85)
    .map(([district, stats]) => ({ district, matchingRate: stats.eligible ? stats.matched / stats.eligible : 0 }))
  return {
    passed: matchingRate >= 0.95 && failedDistricts.length === 0,
    matchingRate,
    totalEligible,
    totalMatched,
    failedDistricts,
  }
}

export async function updateOfficialPrice({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  reuseCache = false,
}) {
  await mkdir(cache, { recursive: true })
  const generated = join(cache, 'generated-price')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const { archives, cutoff } = await downloadArchives(cache, now, reuseCache)
  const archiveHashes = []
  for (const archive of archives) {
    archiveHashes.push(sha256(await readFile(archive.file)))
  }
  const taipeiAddresses = await buildTaipeiAddressIndex(cache, reuseCache)
  const taipei = await processCity('taipei', archives, cutoff, taipeiAddresses.index)
  taipeiAddresses.index.clear()
  const newTaipeiAddresses = await buildNewTaipeiAddressIndex(cache, reuseCache)
  const newTaipei = await processCity('new-taipei', archives, cutoff, newTaipeiAddresses.index)
  newTaipeiAddresses.index.clear()
  const report = qualityReport([taipei, newTaipei])
  const files = []
  const years = new Set()
  for (const { city, slug } of ALL_DISTRICTS) {
    const cityResult = city === 'taipei' ? taipei : newTaipei
    const values = [...cityResult.transactions.get(slug).values()]
      .sort((a, b) => a.date.localeCompare(b.date))
    const byYear = Map.groupBy(values, (item) => Number(item.date.slice(0, 4)))
    if (!byYear.size) byYear.set(now.getFullYear(), [])
    for (const [year, transactions] of byYear) {
      years.add(year)
      const relative = `${city}/${slug}/transactions/${year}.json`
      const destination = join(generated, relative)
      await mkdir(join(generated, city, slug, 'transactions'), { recursive: true })
      await writeFile(destination, `${JSON.stringify(transactions)}\n`)
      files.push(relative)
    }
  }
  await writeFile(join(generated, 'quality.json'), `${JSON.stringify({
    generatedAt: now.toISOString(),
    ...report,
    districts: { taipei: taipei.stats, 'new-taipei': newTaipei.stats },
  }, null, 2)}\n`)
  if (!report.passed) {
    return { status: 'failed', report, files: [], generated }
  }
  if (!dryRun) {
    for (const { city, slug } of ALL_DISTRICTS) {
      await rm(join(output, city, slug, 'transactions'), { recursive: true, force: true })
    }
    await cp(generated, output, { recursive: true, filter: (source) => !source.endsWith('quality.json') })
  }
  const recordCount = report.totalMatched
  const excluded = Object.values({ ...taipei.stats, ...newTaipei.stats })
    .flatMap((stats) => Object.entries(stats.excluded))
    .reduce((totals, [reason, count]) => ({ ...totals, [reason]: (totals[reason] ?? 0) + count }), {})
  return {
    status: dryRun ? 'dry-run' : 'official',
    report,
    files,
    recordCount,
    matchingRate: report.matchingRate,
    years: [...years].sort(),
    sha256: sha256(
      `${archiveHashes.join(':')}:${taipeiAddresses.sha256}:${newTaipeiAddresses.sha256}:${recordCount}`,
    ),
    excluded,
    version: `price-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    generated,
  }
}
