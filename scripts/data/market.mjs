import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildNewTaipeiAddressIndex, buildTaipeiAddressIndex, matchAddress } from './address-index.mjs'
import { downloadFile, inTaipeiMetroArea, parseCsvLine, sha256, stableId } from './core.mjs'
import { ALL_DISTRICTS, DISTRICTS, EMPTY_GEOJSON, SOURCE_URLS } from './constants.mjs'
import { sourceFilesSha256 } from './manifest.mjs'
import { pointMatchesDistrict } from './transport.mjs'

export const MARKET_ADAPTER_VERSION = 'market-v2'
export const MARKET_BLOCKED_REASON =
  '雙北傳統零售市場缺少可證明現況、可重現下載的官方機器可讀清冊'

const FRESH_STALL_FIELDS = [
  '蔬菜（數量）',
  '青果（數量）',
  '獸肉（數量）',
  '漁產（數量）',
  '家禽（數量）',
  '糧食（數量）',
]

export function decodeMarketCsv(value, encoding = 'utf-8') {
  if (typeof value === 'string') return value.replace(/^\uFEFF/, '')
  return new TextDecoder(encoding).decode(value).replace(/^\uFEFF/, '')
}

function csvRecordLines(text) {
  const records = []
  let current = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') {
      current += character
      if (quoted && text[index + 1] === '"') {
        current += text[index + 1]
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      if (current.trim()) records.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (quoted) throw new Error('market CSV 含未關閉的引號')
  if (current.trim()) records.push(current)
  return records
}

export function parseMarketCsv(text) {
  const records = csvRecordLines(String(text))
  const headers = parseCsvLine(records.shift() ?? '')
    .map((value) => value.replace(/^\uFEFF/, '').trim())
  return records.map((record) => {
    const values = parseCsvLine(record)
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

export function normalizeMarketName(value) {
  return String(value ?? '').normalize('NFKC')
    .replaceAll('台', '臺')
    .replace(/^臺北市公有/, '')
    .replace(/\(([12])\)/g, (_match, value) => value === '1' ? '一' : '二')
    .replace(/[（(](?:\d{2,4}|BOT|店鋪|臨時攤棚|[12]樓)[）)]/gi, '')
    .replace(/(?:臨時攤棚|中繼)/g, '')
    .replace(/[()（）\[\]【】\s]/g, '')
}

function displayMarketName(value) {
  return String(value ?? '').normalize('NFKC')
    .replaceAll('台', '臺')
    .replace(/^臺北市公有/, '')
    .trim()
}

function freshStallCount(row) {
  return FRESH_STALL_FIELDS.reduce((sum, field) => {
    const value = Number(String(row[field] ?? '').replaceAll(',', '').trim())
    return sum + (Number.isFinite(value) && value > 0 ? value : 0)
  }, 0)
}

export function classifyTaipeiPublicMarkets(stallCsv) {
  const classifications = new Map()
  for (const row of parseMarketCsv(stallCsv)) {
    const name = valueFor(row, ['市場名稱'])
    const normalizedName = normalizeMarketName(name)
    if (!normalizedName) continue
    const current = classifications.get(normalizedName) ?? {
      rowCount: 0,
      freshStallCount: 0,
    }
    current.rowCount += 1
    current.freshStallCount += freshStallCount(row)
    classifications.set(normalizedName, current)
  }
  return classifications
}

function location(city, districtValue, address) {
  const labels = Object.keys(DISTRICTS[city])
  const districtLabel = labels.find((label) =>
    String(districtValue).includes(label) || String(address).includes(label))
  return districtLabel
    ? { city, district: DISTRICTS[city][districtLabel], districtLabel }
    : null
}

function coordinateFromRow(row) {
  const longitude = Number(valueFor(row, ['GTag_longitude', 'longitude', '經度']))
  const latitude = Number(valueFor(row, ['GTag_latitude', 'latitude', '緯度']))
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    ? { longitude, latitude }
    : null
}

function districtForCoordinate(boundaries, city, coordinate) {
  if (!coordinate || !inTaipeiMetroArea(coordinate)) return null
  const matches = ALL_DISTRICTS
    .filter((item) => item.city === city)
    .filter((item) => {
      const boundary = boundaries.get(`${city}/${item.slug}`)
      return boundary && pointMatchesDistrict(boundary, coordinate)
    })
  return matches.length === 1
    ? {
        city,
        district: matches[0].slug,
        districtLabel: matches[0].label,
      }
    : null
}

function addressValues(address) {
  const normalized = String(address ?? '').normalize('NFKC').trim()
  const districtDeduplicated = Object.keys(DISTRICTS.taipei)
    .concat(Object.keys(DISTRICTS['new-taipei']))
    .reduce(
      (value, district) => value.replaceAll(`${district}${district}`, district),
      normalized,
    )
  return [...new Set([
    normalized,
    districtDeduplicated,
    ...districtDeduplicated.split(/\r?\n/).map((value) =>
      value.replace(/[（(](?:通訊地址|.*?至.*?)[）)].*$/g, '').trim()),
  ].filter(Boolean))]
}

function uniqueAddressMatch(addressIndex, addresses, city, preferredPlace) {
  const districtLabels = preferredPlace
    ? [preferredPlace.districtLabel]
    : Object.keys(DISTRICTS[city])
  const matches = []
  for (const districtLabel of districtLabels) {
    for (const address of addresses) {
      const matched = matchAddress(addressIndex, address, city, districtLabel)
      if (matched.status === 'matched') {
        matches.push({
          coordinate: matched.coordinate,
          address,
          place: {
            city,
            district: DISTRICTS[city][districtLabel],
            districtLabel,
          },
        })
        break
      }
    }
  }
  const unique = new Map(matches.map((item) => [
    `${item.place.district}:${item.coordinate.longitude.toFixed(7)}:${item.coordinate.latitude.toFixed(7)}`,
    item,
  ]))
  return unique.size === 1 ? [...unique.values()][0] : null
}

function coordinateDistance(first, second) {
  return Math.hypot(
    (first.latitude - second.latitude) * 111000,
    (first.longitude - second.longitude) * 101000,
  )
}

function makeMarketItem({
  city,
  namespace,
  ownership,
  officialId,
  name,
  address,
  place,
  coordinate,
  sourceUpdatedAt,
  locationMethod,
  classificationMethod,
  freshStallCount: classifiedFreshStallCount = null,
}) {
  const normalizedName = normalizeMarketName(name)
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
    coordinate,
    classificationMethod,
    evidence: {
      addressSha256: sha256(address),
      locationMethod,
      marketOwnership: ownership,
      classificationMethod,
      namespace,
      ...(classifiedFreshStallCount === null
        ? {}
        : { freshStallCount: classifiedFreshStallCount }),
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
        coordinates: [coordinate.longitude, coordinate.latitude],
      },
    },
  }
}

function parseTaipeiPublicMarkets({
  publicCsv,
  publicStallCsv,
  addressIndex,
  boundaries,
  sourceUpdatedAt,
}) {
  const classifications = classifyTaipeiPublicMarkets(publicStallCsv)
  return parseMarketCsv(publicCsv).map((row) => {
    const rawName = valueFor(row, ['stitle', '市場名稱', 'name'])
    const name = displayMarketName(rawName)
    const normalizedName = normalizeMarketName(rawName)
    const classification = classifications.get(normalizedName)
    if (!classification || classification.freshStallCount <= 0) {
      return {
        city: 'taipei',
        excluded: 'noFreshFoodStalls',
        classificationEligible: false,
        name,
      }
    }
    const address = valueFor(row, ['xAddress', '市場地址', 'address']).normalize('NFKC')
    const officialId = valueFor(row, ['seqno', '序號', 'id'])
    const officialCoordinate = coordinateFromRow(row)
    const coordinatePlace = districtForCoordinate(boundaries, 'taipei', officialCoordinate)
    const addressPlace = location('taipei', '', address)
    const matched = uniqueAddressMatch(
      addressIndex,
      addressValues(address),
      'taipei',
      addressPlace ?? coordinatePlace,
    )
    if (matched && coordinatePlace) {
      if (matched.place.district !== coordinatePlace.district) {
        throw new Error(`${name} 官方座標與門牌行政區不一致`)
      }
      const distance = coordinateDistance(matched.coordinate, officialCoordinate)
      if (distance > 150) {
        throw new Error(`${name} 官方座標與門牌座標相差 ${distance.toFixed(1)} 公尺，超過 150 公尺`)
      }
    }
    const located = matched ?? (
      officialCoordinate && coordinatePlace
        ? {
            coordinate: officialCoordinate,
            place: coordinatePlace,
            address,
            locationMethod: 'official-coordinate-fallback',
          }
        : null
    )
    if (!rawName || !address || !located) {
      return {
        city: 'taipei',
        excluded: 'unmatchedAddress',
        classificationEligible: true,
        name,
        sourceRecordId: officialId,
        addressSha256: sha256(address),
        marketOwnership: 'public',
      }
    }
    return makeMarketItem({
      city: 'taipei',
      namespace: 'taipei-public-market',
      ownership: 'public',
      officialId,
      name,
      address,
      place: located.place,
      coordinate: located.coordinate,
      sourceUpdatedAt,
      locationMethod: located.locationMethod ?? 'address-index-exact',
      classificationMethod: 'fresh-stall-count',
      freshStallCount: classification.freshStallCount,
    })
  })
}

function parseTaipeiPrivateMarkets({
  privateCsv,
  addressIndex,
  sourceUpdatedAt,
}) {
  return parseMarketCsv(privateCsv).map((row) => {
    const name = valueFor(row, ['市場名稱', 'name'])
    const address = valueFor(row, ['市場地址', 'address']).normalize('NFKC')
    const preferredPlace = location(
      'taipei',
      valueFor(row, ['行政區']),
      address,
    )
    const matched = uniqueAddressMatch(
      addressIndex,
      addressValues(address),
      'taipei',
      preferredPlace,
    )
    if (!name || !address || !matched) {
      return {
        city: 'taipei',
        excluded: 'unmatchedAddress',
        classificationEligible: true,
        name,
        addressSha256: sha256(address),
        marketOwnership: 'private',
      }
    }
    return makeMarketItem({
      city: 'taipei',
      namespace: 'taipei-private-market',
      ownership: 'private',
      officialId: '',
      name,
      address,
      place: matched.place,
      coordinate: matched.coordinate,
      sourceUpdatedAt,
      locationMethod: 'address-index-exact',
      classificationMethod: 'official-private-registry',
    })
  })
}

export function parseTaipeiMarkets({
  publicCsv,
  publicStallCsv,
  privateCsv,
  addressIndex,
  boundaries = new Map(),
  sourceUpdatedAt,
}) {
  return [
    ...parseTaipeiPublicMarkets({
      publicCsv,
      publicStallCsv,
      addressIndex,
      boundaries,
      sourceUpdatedAt,
    }),
    ...parseTaipeiPrivateMarkets({
      privateCsv,
      addressIndex,
      sourceUpdatedAt,
    }),
  ]
}

export function parseNewTaipeiMarkets(text, addressIndex, sourceUpdatedAt) {
  return parseMarketCsv(text).map((row) => {
    const type = valueFor(row, ['types', '類型'])
    const isTraditional = (
      type.includes('早') ||
      type.includes('午市') ||
      type.includes('黃昏') ||
      type.includes('公有市場')
    ) && !type.includes('超市') && !type.includes('批發') && !type.includes('夜市')
    if (!isTraditional) {
      return {
        excluded: 'notTraditionalMarket',
        city: 'new-taipei',
        classificationEligible: false,
      }
    }
    const name = valueFor(row, ['市場名稱', 'name', '名稱'])
    const address = valueFor(row, ['市場地址', 'address', '地址']).normalize('NFKC')
    const place = location(
      'new-taipei',
      valueFor(row, ['行政區', 'town', 'area']),
      address,
    )
    const matched = place
      ? uniqueAddressMatch(addressIndex, addressValues(address), 'new-taipei', place)
      : null
    if (!name || !address || !matched) {
      return {
        city: 'new-taipei',
        excluded: 'unmatchedAddress',
        classificationEligible: true,
        name,
        sourceRecordId: valueFor(row, ['序號', 'item', 'id', 'seqno']),
        addressSha256: sha256(address),
        marketOwnership: 'public',
      }
    }
    return makeMarketItem({
      city: 'new-taipei',
      namespace: 'new-taipei-public-market',
      ownership: 'public',
      officialId: valueFor(row, ['序號', 'item', 'id', 'seqno']),
      name,
      address,
      place: matched.place,
      coordinate: matched.coordinate,
      sourceUpdatedAt,
      locationMethod: 'address-index-exact',
      classificationMethod: 'official-type-traditional-market',
    })
  })
}

function matchingRates(items) {
  const result = {}
  for (const city of ['taipei', 'new-taipei']) {
    const eligible = items.filter((item) =>
      item.city === city && item.classificationEligible !== false)
    result[city] = eligible.length
      ? eligible.filter((item) => !item.excluded).length / eligible.length
      : 0
  }
  const eligible = items.filter((item) => item.classificationEligible !== false)
  result.overall = eligible.length
    ? eligible.filter((item) => !item.excluded).length / eligible.length
    : 0
  return result
}

function assertMatchingRates(rates) {
  for (const [scope, rate] of Object.entries(rates)) {
    if (rate < 0.95) {
      throw new Error(`market ${scope} 定位率 ${(rate * 100).toFixed(2)}% 未達 95%`)
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
    const coordinateKey = item.feature.geometry.coordinates
      .map((value) => value.toFixed(7))
      .join(':')
    if (seenIds.has(id)) {
      excluded.duplicateId = (excluded.duplicateId ?? 0) + 1
      continue
    }
    const boundary = boundaries.get(`${item.city}/${item.district}`)
    if (!inTaipeiMetroArea(item.coordinate) ||
        !pointMatchesDistrict(boundary, item.coordinate)) {
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
  if (!accepted.some((item) => item.city === 'taipei' &&
      item.feature.properties.marketOwnership === 'public') ||
      !accepted.some((item) => item.city === 'taipei' &&
        item.feature.properties.marketOwnership === 'private')) {
    throw new Error('market 臺北公有與民有市場必須皆有合格資料')
  }
  return { accepted, excluded, duplicateCoordinates }
}

function sampleValue(item) {
  return {
    id: item.feature.properties.id,
    city: item.city,
    district: item.district,
    sourceRecordId: item.rawId,
    name: item.name,
    longitude: item.coordinate.longitude,
    latitude: item.coordinate.latitude,
    marketOwnership: item.feature.properties.marketOwnership,
    classificationMethod: item.classificationMethod,
    evidence: item.evidence,
  }
}

function selectSamples(items) {
  const sorted = [...items].sort((first, second) =>
    first.feature.properties.id.localeCompare(second.feature.properties.id))
  const taipeiPublic = sorted.filter((item) =>
    item.city === 'taipei' && item.feature.properties.marketOwnership === 'public')
  const taipeiPrivate = sorted.filter((item) =>
    item.city === 'taipei' && item.feature.properties.marketOwnership === 'private')
  const fallback = taipeiPublic.find((item) =>
    item.evidence.locationMethod === 'official-coordinate-fallback')
  const selectedPublic = [
    ...(fallback ? [fallback] : []),
    ...taipeiPublic.filter((item) => item !== fallback),
  ].slice(0, 3)
  const taipei = [...selectedPublic, ...taipeiPrivate.slice(0, 2)]
  const newTaipei = sorted.filter((item) => item.city === 'new-taipei').slice(0, 5)
  if (taipei.length < 5 || newTaipei.length < 5) {
    throw new Error('market 無法產生臺北 3 公有＋2 民有及新北 5 筆稽核樣本')
  }
  return {
    taipei: taipei.map(sampleValue),
    'new-taipei': newTaipei.map(sampleValue),
  }
}

async function loadBoundaries(output) {
  const boundaries = new Map()
  for (const { city, slug } of ALL_DISTRICTS) {
    boundaries.set(
      `${city}/${slug}`,
      JSON.parse(await readFile(
        join(output, 'boundaries', city, `${slug}.geojson`),
        'utf8',
      )),
    )
  }
  return boundaries
}

async function rawFile(cache, name, url, reuseCache) {
  const directory = join(cache, 'market')
  await mkdir(directory, { recursive: true })
  const file = join(directory, name)
  if (!reuseCache || !await readFile(file).catch(() => null)) {
    await downloadFile(url, file)
  }
  return readFile(file)
}

async function writeMarketFiles(generated, items) {
  const grouped = new Map(
    ALL_DISTRICTS.map(({ city, slug }) => [`${city}/${slug}`, []]),
  )
  for (const item of items) {
    grouped.get(`${item.city}/${item.district}`).push(item.feature)
  }
  const files = []
  for (const [key, features] of grouped) {
    const relative = `${key}/facilities/market.geojson`
    const target = join(generated, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify({ ...EMPTY_GEOJSON, features })}\n`)
    if ((await stat(target)).size > 5 * 1024 * 1024) {
      throw new Error(`${relative} 超過 5 MB`)
    }
    files.push(relative)
  }
  return files
}

function countBy(items, value) {
  return Object.fromEntries([...new Set(items.map(value))]
    .sort()
    .map((key) => [key, items.filter((item) => value(item) === key).length]))
}

export async function updateOfficialMarkets({
  output,
  cache,
  now = new Date(),
  reuseCache = false,
  previous = {},
  sourceUrls = {
    taipeiPublic: SOURCE_URLS.taipeiPublicMarket,
    taipeiPublicStalls: SOURCE_URLS.taipeiPublicMarketStalls,
    taipeiPrivate: SOURCE_URLS.taipeiPrivateMarket,
    newTaipei: SOURCE_URLS.newTaipeiMarket,
  },
}) {
  const candidateFile = join(cache, 'market-audit-candidates.json')
  if (Object.values(sourceUrls).some((url) => !url)) {
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
  const [
    taipeiPublic,
    taipeiPublicStalls,
    taipeiPrivate,
    newTaipei,
    taipeiIndex,
    newTaipeiIndex,
    boundaries,
  ] = await Promise.all([
    rawFile(cache, 'taipei-public-market.csv', sourceUrls.taipeiPublic, reuseCache),
    rawFile(cache, 'taipei-public-market-stalls.csv', sourceUrls.taipeiPublicStalls, reuseCache),
    rawFile(cache, 'taipei-private-market.csv', sourceUrls.taipeiPrivate, reuseCache),
    rawFile(cache, 'new-taipei-market.csv', sourceUrls.newTaipei, reuseCache),
    buildTaipeiAddressIndex(cache, reuseCache),
    buildNewTaipeiAddressIndex(cache, reuseCache),
    loadBoundaries(output),
  ])
  const parsed = [
    ...parseTaipeiMarkets({
      publicCsv: decodeMarketCsv(taipeiPublic, 'big5'),
      publicStallCsv: decodeMarketCsv(taipeiPublicStalls, 'big5'),
      privateCsv: decodeMarketCsv(taipeiPrivate, 'big5'),
      addressIndex: taipeiIndex.index,
      boundaries,
      sourceUpdatedAt: now.toISOString(),
    }),
    ...parseNewTaipeiMarkets(
      decodeMarketCsv(newTaipei),
      newTaipeiIndex.index,
      now.toISOString(),
    ),
  ]
  const rates = matchingRates(parsed)
  const sourceSha256 = sha256([
    taipeiPublic,
    taipeiPublicStalls,
    taipeiPrivate,
    newTaipei,
  ].map(sha256).join(':'))
  const excluded = countBy(
    parsed.filter((item) => item.excluded),
    (item) => item.excluded,
  )
  const located = parsed.filter((item) => !item.excluded)
  const locationMethods = countBy(
    located,
    (item) => item.evidence.locationMethod,
  )
  const ownership = countBy(
    located,
    (item) => `${item.city}/${item.feature.properties.marketOwnership}`,
  )
  try {
    assertMatchingRates(rates)
  } catch (error) {
    const candidates = {
      adapterVersion: MARKET_ADAPTER_VERSION,
      generatedAt: now.toISOString(),
      status: 'blocked',
      blockedReason: error.message,
      sourceSha256,
      addressIndexSha256: {
        taipei: taipeiIndex.sha256,
        'new-taipei': newTaipeiIndex.sha256,
      },
      matchingRates: rates,
      qualityReport: {
        excluded,
        locationMethods,
        ownership,
        unmatched: parsed
          .filter((item) => item.classificationEligible !== false && item.excluded)
          .map((item) => ({
            city: item.city,
            sourceRecordId: item.sourceRecordId ?? '',
            name: item.name ?? '',
            addressSha256: item.addressSha256 ?? '',
            marketOwnership: item.marketOwnership ?? '',
          })),
      },
      samples: { taipei: [], 'new-taipei': [] },
    }
    await writeFile(candidateFile, `${JSON.stringify(candidates, null, 2)}\n`)
    taipeiIndex.index.clear()
    newTaipeiIndex.index.clear()
    throw error
  }
  const quality = qualityFilter(parsed, boundaries)
  const files = await writeMarketFiles(generated, quality.accepted)
  if (previous.recordCount > 0 &&
      quality.accepted.length < previous.recordCount * 0.9) {
    throw new Error(
      `market 筆數較 last-good 異常下降：${previous.recordCount} → ${quality.accepted.length}`,
    )
  }
  const datasetSha256 = await sourceFilesSha256(generated, files)
  const releaseSource = {
    id: 'market',
    version: `market-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: quality.accepted.length,
    sha256: sourceSha256,
    matchingRate: rates.overall,
    matchingRates: rates,
    excluded,
    locationMethods,
    ownership,
    files,
    adapterVersion: MARKET_ADAPTER_VERSION,
  }
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
    qualityReport: {
      excluded,
      locationMethods,
      ownership,
      duplicateCoordinates: quality.duplicateCoordinates,
    },
    releaseSource,
    fingerprints: {
      sourceSha256,
      datasetSha256,
    },
    samples: selectSamples(quality.accepted),
  }
  await writeFile(candidateFile, `${JSON.stringify(candidates, null, 2)}\n`)
  taipeiIndex.index.clear()
  newTaipeiIndex.index.clear()
  return {
    ...releaseSource,
    status: 'candidate',
    qualityReport: candidates.qualityReport,
  }
}
