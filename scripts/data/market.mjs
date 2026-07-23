import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildNewTaipeiAddressIndex, buildTaipeiAddressIndex, matchAddress } from './address-index.mjs'
import { downloadFile, inTaipeiMetroArea, parseCsvLine, sha256, stableId } from './core.mjs'
import { ALL_DISTRICTS, DISTRICTS, EMPTY_GEOJSON, SOURCE_URLS } from './constants.mjs'
import { sourceFilesSha256 } from './manifest.mjs'
import { pointMatchesDistrict } from './transport.mjs'

export const MARKET_ADAPTER_VERSION = 'market-v1'
export const MARKET_BLOCKED_REASON =
  '臺北公有傳統零售市場缺少可證明現況、可重現下載的官方機器可讀清冊'

function csvRecords(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim())
  const headers = parseCsvLine(lines.shift() ?? '').map((value) => value.replace(/^\uFEFF/, '').trim())
  return lines.map((line) => {
    const values = parseCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

function valueFor(row, names) {
  for (const name of names) {
    const value = String(row[name] ?? '').trim()
    if (value) return value
  }
  return ''
}

function normalizeName(value) {
  return String(value ?? '').normalize('NFKC')
    .replaceAll('台', '臺')
    .replace(/[()（）\[\]【】\s]/g, '')
}

function location(city, districtValue, address) {
  const labels = Object.keys(DISTRICTS[city])
  const districtLabel = labels.find((label) =>
    String(districtValue).includes(label) || String(address).includes(label))
  return districtLabel
    ? { city, district: DISTRICTS[city][districtLabel], districtLabel }
    : null
}

function marketCandidate({
  city,
  namespace,
  ownership,
  row,
  addressIndex,
  sourceUpdatedAt,
}) {
  const name = valueFor(row, ['市場名稱', 'name', '名稱'])
  const address = valueFor(row, ['市場地址', 'address', '地址']).normalize('NFKC')
  const districtValue = valueFor(row, ['行政區', 'town', 'area'])
  const place = location(city, districtValue, address)
  const officialId = valueFor(row, ['序號', 'item', 'id', 'seqno'])
  if (!name || !place || !address.includes('號')) {
    return { excluded: 'invalidCoreFields', city }
  }
  const matched = matchAddress(addressIndex, address, city, place.districtLabel)
  if (matched.status !== 'matched') {
    return { excluded: `${matched.status}Address`, city }
  }
  const normalizedName = normalizeName(name)
  const identity = officialId || `${place.district}|${normalizedName}`
  const id = stableId([
    'market',
    city,
    namespace,
    officialId || '',
    place.district,
    normalizedName,
    'traditional-retail',
  ])
  return {
    rawId: officialId || identity,
    city,
    district: place.district,
    name,
    coordinate: matched.coordinate,
    evidence: {
      addressSha256: sha256(address),
      locationMethod: 'address-index-exact',
      marketOwnership: ownership,
      namespace,
    },
    feature: {
      type: 'Feature',
      properties: {
        id,
        name,
        category: 'market',
        facilityType: 'traditional-market',
        marketOwnership: ownership,
        sourceUpdatedAt,
      },
      geometry: {
        type: 'Point',
        coordinates: [matched.coordinate.longitude, matched.coordinate.latitude],
      },
    },
  }
}

export function parseTaipeiMarkets({
  publicCsv,
  privateCsv,
  addressIndex,
  sourceUpdatedAt,
}) {
  const definitions = [
    ['taipei-public-market', 'public', publicCsv],
    ['taipei-private-market', 'private', privateCsv],
  ]
  return definitions.flatMap(([namespace, ownership, text]) =>
    csvRecords(text).map((row) => marketCandidate({
      city: 'taipei',
      namespace,
      ownership,
      row,
      addressIndex,
      sourceUpdatedAt,
    })))
}

export function parseNewTaipeiMarkets(text, addressIndex, sourceUpdatedAt) {
  return csvRecords(text).map((row) => {
    const type = valueFor(row, ['types', '類型'])
    if (!type.includes('市場') || type.includes('超市') || type.includes('批發') || type.includes('夜市')) {
      return { excluded: 'notTraditionalMarket', city: 'new-taipei' }
    }
    return marketCandidate({
      city: 'new-taipei',
      namespace: 'new-taipei-public-market',
      ownership: 'public',
      row,
      addressIndex,
      sourceUpdatedAt,
    })
  })
}

function matchingRates(items) {
  const result = {}
  for (const city of ['taipei', 'new-taipei']) {
    const eligible = items.filter((item) =>
      item.city === city && item.excluded !== 'notTraditionalMarket')
    const matched = eligible.filter((item) => !item.excluded)
    result[city] = eligible.length ? matched.length / eligible.length : 0
  }
  const eligible = items.filter((item) =>
    item.excluded !== 'notTraditionalMarket')
  result.overall = eligible.length
    ? eligible.filter((item) => !item.excluded).length / eligible.length
    : 0
  return result
}

function assertMatchingRates(rates) {
  for (const [scope, rate] of Object.entries(rates)) {
    if (rate < 0.95) {
      throw new Error(`market ${scope} 門牌匹配率 ${(rate * 100).toFixed(2)}% 未達 95%`)
    }
  }
}

function qualityFilter(items, boundaries) {
  const accepted = []
  const excluded = {}
  const seenIds = new Set()
  const coordinates = new Map()
  for (const item of items) {
    if (item.excluded) {
      excluded[item.excluded] = (excluded[item.excluded] ?? 0) + 1
      continue
    }
    const id = item.feature.properties.id
    const coordinateKey = item.feature.geometry.coordinates.map((value) => value.toFixed(7)).join(':')
    if (seenIds.has(id)) {
      excluded.duplicateId = (excluded.duplicateId ?? 0) + 1
      continue
    }
    const boundary = boundaries.get(`${item.city}/${item.district}`)
    if (!inTaipeiMetroArea(item.coordinate) || !pointMatchesDistrict(boundary, item.coordinate)) {
      excluded.districtMismatch = (excluded.districtMismatch ?? 0) + 1
      continue
    }
    seenIds.add(id)
    coordinates.set(coordinateKey, (coordinates.get(coordinateKey) ?? 0) + 1)
    accepted.push(item)
  }
  const duplicateCoordinates = [...coordinates.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  if (accepted.length && duplicateCoordinates / accepted.length >= 0.01) {
    throw new Error(`market 重複點位率 ${(duplicateCoordinates / accepted.length * 100).toFixed(2)}% 未低於 1%`)
  }
  if (excluded.districtMismatch) {
    throw new Error(`market 有 ${excluded.districtMismatch} 筆座標與行政區界不一致`)
  }
  return { accepted, excluded }
}

function selectSamples(items) {
  return Object.fromEntries(['taipei', 'new-taipei'].map((city) => [
    city,
    items.filter((item) => item.city === city)
      .sort((a, b) => a.feature.properties.id.localeCompare(b.feature.properties.id))
      .slice(0, 5)
      .map((item) => ({
        id: item.feature.properties.id,
        city,
        district: item.district,
        sourceRecordId: item.rawId,
        name: item.name,
        longitude: item.coordinate.longitude,
        latitude: item.coordinate.latitude,
        marketOwnership: item.feature.properties.marketOwnership,
        evidence: item.evidence,
      })),
  ]))
}

async function loadBoundaries(output) {
  const boundaries = new Map()
  for (const { city, slug } of ALL_DISTRICTS) {
    boundaries.set(
      `${city}/${slug}`,
      JSON.parse(await readFile(join(output, 'boundaries', city, `${slug}.geojson`), 'utf8')),
    )
  }
  return boundaries
}

async function rawFile(cache, name, url, reuseCache) {
  const directory = join(cache, 'market')
  await mkdir(directory, { recursive: true })
  const file = join(directory, name)
  if (!reuseCache || !await readFile(file).catch(() => null)) await downloadFile(url, file)
  return readFile(file)
}

async function writeMarketFiles(generated, items) {
  const grouped = new Map(ALL_DISTRICTS.map(({ city, slug }) => [`${city}/${slug}`, []]))
  for (const item of items) grouped.get(`${item.city}/${item.district}`).push(item.feature)
  const files = []
  for (const [key, features] of grouped) {
    const relative = `${key}/facilities/market.geojson`
    await mkdir(dirname(join(generated, relative)), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features })}\n`)
    files.push(relative)
  }
  return files
}

export async function updateOfficialMarkets({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  reuseCache = false,
  previous = {},
  sourceUrls = {
    taipeiPublic: SOURCE_URLS.taipeiPublicMarket,
    taipeiPrivate: SOURCE_URLS.taipeiPrivateMarket,
    newTaipei: SOURCE_URLS.newTaipeiMarket,
  },
}) {
  const candidateFile = join(cache, 'market-audit-candidates.json')
  if (!sourceUrls.taipeiPublic || !sourceUrls.taipeiPrivate) {
    const candidates = {
      adapterVersion: MARKET_ADAPTER_VERSION,
      generatedAt: now.toISOString(),
      status: 'blocked',
      blockedReason: MARKET_BLOCKED_REASON,
      samples: { taipei: [], 'new-taipei': [] },
    }
    await writeFile(candidateFile, `${JSON.stringify(candidates, null, 2)}\n`)
    return { id: 'market', status: 'failed', error: MARKET_BLOCKED_REASON }
  }

  const generated = join(cache, 'generated-market')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const [taipeiPublic, taipeiPrivate, newTaipei, taipeiIndex, newTaipeiIndex, boundaries] =
    await Promise.all([
      rawFile(cache, 'taipei-public-market.csv', sourceUrls.taipeiPublic, reuseCache),
      rawFile(cache, 'taipei-private-market.csv', sourceUrls.taipeiPrivate, reuseCache),
      rawFile(cache, 'new-taipei-market.csv', sourceUrls.newTaipei, reuseCache),
      buildTaipeiAddressIndex(cache, reuseCache),
      buildNewTaipeiAddressIndex(cache, reuseCache),
      loadBoundaries(output),
    ])
  const parsed = [
    ...parseTaipeiMarkets({
      publicCsv: taipeiPublic.toString('utf8'),
      privateCsv: taipeiPrivate.toString('utf8'),
      addressIndex: taipeiIndex.index,
      sourceUpdatedAt: now.toISOString(),
    }),
    ...parseNewTaipeiMarkets(
      newTaipei.toString('utf8'),
      newTaipeiIndex.index,
      now.toISOString(),
    ),
  ]
  const rates = matchingRates(parsed)
  assertMatchingRates(rates)
  const quality = qualityFilter(parsed, boundaries)
  const files = await writeMarketFiles(generated, quality.accepted)
  if (previous.recordCount > 0 && quality.accepted.length < previous.recordCount * 0.9) {
    throw new Error(`market 筆數較 last-good 異常下降：${previous.recordCount} → ${quality.accepted.length}`)
  }
  const sourceSha256 = sha256([taipeiPublic, taipeiPrivate, newTaipei].map(sha256).join(':'))
  const candidates = {
    adapterVersion: MARKET_ADAPTER_VERSION,
    generatedAt: now.toISOString(),
    status: 'ready',
    sourceSha256,
    addressIndexSha256: {
      taipei: taipeiIndex.sha256,
      'new-taipei': newTaipeiIndex.sha256,
    },
    matchingRates: rates,
    fingerprints: {
      sourceSha256,
      datasetSha256: await sourceFilesSha256(generated, files),
    },
    samples: selectSamples(quality.accepted),
  }
  await writeFile(candidateFile, `${JSON.stringify(candidates, null, 2)}\n`)
  if (!dryRun) {
    for (const file of files) {
      await mkdir(dirname(join(output, file)), { recursive: true })
      await writeFile(join(output, file), await readFile(join(generated, file)))
    }
  }
  taipeiIndex.index.clear()
  newTaipeiIndex.index.clear()
  return {
    id: 'market',
    status: dryRun ? 'dry-run' : 'official',
    version: `market-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: quality.accepted.length,
    sha256: sourceSha256,
    matchingRate: rates.overall,
    matchingRates: rates,
    excluded: quality.excluded,
    files,
    adapterVersion: MARKET_ADAPTER_VERSION,
  }
}
