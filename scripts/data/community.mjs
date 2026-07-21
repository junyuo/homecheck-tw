import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildNewTaipeiAddressIndex,
  buildTaipeiAddressIndex,
  matchAddress,
} from './address-index.mjs'
import {
  downloadFile,
  inTaipeiMetroArea,
  parseCsvLine,
  sha256,
  stableId,
  twd97ToWgs84,
} from './core.mjs'
import { ALL_DISTRICTS, DISTRICTS, EMPTY_GEOJSON, SOURCE_URLS } from './constants.mjs'
import { sourceFilesSha256 } from './manifest.mjs'
import { pointMatchesDistrict } from './transport.mjs'

export const COMMUNITY_ADAPTER_VERSION = 'community-v2'
export const SCHOOL_YEAR = 114
export const SCHOOL_LEVELS = ['elementary', 'junior', 'senior', 'special']

function csvRecords(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim())
  const headers = parseCsvLine(lines.shift() ?? '').map((value) => value.replace(/^\uFEFF/, ''))
  return lines.map((line) => {
    const values = parseCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

function jsonBuffer(buffer) {
  return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
}

function locationFromAddress(city, address) {
  const districtLabel = Object.keys(DISTRICTS[city])
    .find((label) => String(address).includes(label))
  const district = DISTRICTS[city]?.[districtLabel]
  return district ? { city, district, districtLabel } : null
}

function cityFromRecord(value) {
  const text = String(value)
  if (text.includes('臺北市') || text.includes('台北市')) return 'taipei'
  if (text.includes('新北市')) return 'new-taipei'
  return null
}

function normalizeSchoolName(value) {
  return String(value ?? '').normalize('NFKC')
    .replaceAll('台', '臺')
    .replace(/[()（）\[\]【】\s]/g, '')
}

export function parseNewTaipeiSchoolLandmarks(value) {
  if (!Array.isArray(value)) throw new Error('新北重要地標來源不是陣列')
  const schoolTypes = new Set(['國民小學', '國民中學', '高中職', '完全中學', '教育研究機構'])
  const index = new Map()
  for (const row of value) {
    if (!schoolTypes.has(String(row['地標類型'] ?? '').trim())) continue
    const districtLabel = String(row['行政區'] ?? '').trim()
    const district = DISTRICTS['new-taipei'][districtLabel]
    const name = normalizeSchoolName(row['地標名稱'])
    const coordinate = twd97ToWgs84(row.twd97_x, row.twd97_y)
    if (!district || !name || !coordinate || !inTaipeiMetroArea(coordinate)) continue
    const key = `${districtLabel}|${name}`
    const item = {
      coordinate,
      district,
      districtLabel,
      objectId: String(row.objectid ?? ''),
      rawCoordinate: {
        crs: 'EPSG:3826',
        x: Number(row.twd97_x),
        y: Number(row.twd97_y),
      },
    }
    if (!index.has(key)) index.set(key, item)
    else {
      const previous = index.get(key)
      const distance = Math.hypot(
        (previous.coordinate.latitude - coordinate.latitude) * 111000,
        (previous.coordinate.longitude - coordinate.longitude) * 101000,
      )
      if (distance > 1) index.set(key, null)
    }
  }
  return index
}

function matchSchoolAddress(index, rawAddress, simplifiedAddress, city, districtLabel) {
  const results = [rawAddress, simplifiedAddress]
    .map((address) => matchAddress(index, address, city, districtLabel))
  if (results.some((result) => result.status === 'ambiguous')) {
    return { status: 'ambiguous', coordinate: null }
  }
  const coordinates = results.filter((result) => result.status === 'matched')
    .map((result) => result.coordinate)
  if (!coordinates.length) return { status: 'unmatched', coordinate: null }
  const distinct = new Set(coordinates.map((coordinate) =>
    `${coordinate.longitude.toFixed(7)}:${coordinate.latitude.toFixed(7)}`))
  return distinct.size === 1
    ? { status: 'matched', coordinate: coordinates[0] }
    : { status: 'ambiguous', coordinate: null }
}

function pointFeature({
  source,
  rawId,
  city,
  district,
  name,
  coordinate,
  sourceUpdatedAt,
  properties,
  evidence,
}) {
  return {
    rawId: String(rawId),
    city,
    district,
    name: String(name).trim(),
    coordinate,
    evidence,
    feature: {
      type: 'Feature',
      properties: {
        id: stableId([source, city, rawId]),
        name: String(name).trim(),
        category: source,
        sourceUpdatedAt,
        ...properties,
      },
      geometry: {
        type: 'Point',
        coordinates: [coordinate.longitude, coordinate.latitude],
      },
    },
  }
}

function schoolRows(value, level) {
  if (!Array.isArray(value)) throw new Error(`${level} 學校來源不是陣列`)
  const years = value
    .map((row) => Number(row['學年度']))
    .filter(Number.isInteger)
  const latestYear = years.length ? Math.max(...years) : SCHOOL_YEAR
  if (latestYear !== SCHOOL_YEAR) {
    throw new Error(`${level} 最新學年度 ${latestYear}，預期 ${SCHOOL_YEAR}`)
  }
  return value.filter((row) => Number(row['學年度'] ?? SCHOOL_YEAR) === latestYear)
}

export function parseSchools(rawSources, indexes, sourceUpdatedAt, landmarkIndex = new Map()) {
  const definitions = [
    ['elementary', schoolRows(rawSources.elementary, 'elementary')],
    ['junior', schoolRows(rawSources.junior, 'junior')],
    ['senior', schoolRows(rawSources.senior, 'senior')],
    ['special', csvRecords(rawSources.special)],
  ]
  const parsed = []
  for (const [level, rows] of definitions) {
    for (const row of rows) {
      const city = cityFromRecord(row['縣市名稱'] ?? row['縣市'])
      if (!city) continue
      const rawAddress = String(row['地址'] ?? '').normalize('NFKC')
        .replace(/^\[[^\]]+\]/, '')
      const location = locationFromAddress(city, rawAddress)
      const name = String(row['學校名稱'] ?? row['學校'] ?? '').trim()
      const officialCode = String(row['代碼'] ?? '').trim()
      if (!location || !name || !rawAddress.includes('號')) {
        parsed.push({ excluded: 'invalidCoreFields', city })
        continue
      }
      const address = rawAddress
        .replace(
          new RegExp(`${location.districtLabel}[^路街大道]{1,8}里(?:\\d+鄰)?`),
          location.districtLabel,
        )
        .replace(/\d+鄰/g, '')
        .replaceAll('褔', '福')
      const matched = matchSchoolAddress(
        indexes[city].index,
        rawAddress,
        address,
        city,
        location.districtLabel,
      )
      const landmark = city === 'new-taipei'
        ? landmarkIndex.get(`${location.districtLabel}|${normalizeSchoolName(name)}`)
        : undefined
      const coordinate = matched.status === 'matched' ? matched.coordinate : landmark?.coordinate
      const locationMethod = matched.status === 'matched'
        ? 'address-index-exact'
        : landmark
          ? 'ntpc-landmark-exact'
          : null
      if (!coordinate || !locationMethod) {
        parsed.push({ excluded: landmark === null ? 'ambiguousLandmark' : `${matched.status}Address`, city })
        continue
      }
      const addressSha256 = sha256(address)
      parsed.push(pointFeature({
        source: 'school',
        rawId: officialCode || stableId(['special-school', city, name]),
        ...location,
        name,
        coordinate,
        sourceUpdatedAt,
        properties: {
          facilityType: 'school-campus',
          schoolLevels: [level],
          officialCodes: officialCode ? [officialCode] : [],
        },
        evidence: {
          addressSha256,
          level,
          officialCode,
          locationMethod,
          ...(locationMethod === 'ntpc-landmark-exact'
            ? { landmarkObjectId: landmark.objectId, rawCoordinate: landmark.rawCoordinate }
            : {}),
        },
      }))
    }
  }
  return parsed
}

function distanceMeters(first, second) {
  return Math.hypot(
    (first.latitude - second.latitude) * 111000,
    (first.longitude - second.longitude) * 101000,
  )
}

export function mergeSchoolCampuses(items) {
  const merged = []
  for (const item of items) {
    if (item.excluded) {
      merged.push(item)
      continue
    }
    const existing = merged.find((candidate) =>
      !candidate.excluded &&
      candidate.city === item.city &&
      candidate.district === item.district &&
      candidate.evidence.addressSha256 === item.evidence.addressSha256 &&
      distanceMeters(candidate.coordinate, item.coordinate) <= 30)
    if (!existing) {
      merged.push(item)
      continue
    }
    const levels = new Set([
      ...existing.feature.properties.schoolLevels,
      ...item.feature.properties.schoolLevels,
    ])
    const codes = new Set([
      ...existing.feature.properties.officialCodes,
      ...item.feature.properties.officialCodes,
    ])
    existing.feature.properties.schoolLevels = [...levels].sort()
    existing.feature.properties.officialCodes = [...codes].sort()
    existing.rawId = [...new Set([existing.rawId, item.rawId])].sort().join('+')
    existing.feature.properties.id = stableId([
      'school',
      existing.city,
      existing.evidence.addressSha256,
      ...existing.feature.properties.officialCodes,
    ])
  }
  return merged
}

function parkType(value) {
  const text = String(value).trim()
  if (text.includes('廣場')) return 'plaza'
  if (text.includes('綠地')) return 'green-space'
  if (text.includes('公園')) return 'park'
  return null
}

export function parseTaipeiParks(value, sourceUpdatedAt, boundaries = null) {
  if (!Array.isArray(value)) throw new Error('臺北公園來源不是陣列')
  return value.map((row) => {
    const name = String(row.pm_name ?? '').trim()
    const type = parkType(row.pm_type)
    const coordinate = {
      longitude: Number(row.pm_Longitude),
      latitude: Number(row.pm_Latitude),
    }
    const addressLocation = locationFromAddress('taipei', row.pm_location)
    const boundaryLocation = boundaries
      ? ALL_DISTRICTS
        .filter(({ city }) => city === 'taipei')
        .find(({ city, slug }) =>
          pointMatchesDistrict(boundaries.get(`${city}/${slug}`), coordinate))
      : null
    const location = addressLocation ?? (boundaryLocation
      ? {
          city: boundaryLocation.city,
          district: boundaryLocation.slug,
          districtLabel: Object.entries(DISTRICTS.taipei)
            .find(([, slug]) => slug === boundaryLocation.slug)?.[0],
        }
      : null)
    if (!row.SeqNo || !name || !type || !location || !inTaipeiMetroArea(coordinate)) {
      return { excluded: 'invalidCoreFields', city: 'taipei' }
    }
    return pointFeature({
      source: 'park',
      rawId: row.SeqNo,
      ...location,
      name,
      coordinate,
      sourceUpdatedAt,
      properties: { facilityType: 'park-area', parkType: type },
      evidence: { rawCoordinate: { crs: 'EPSG:4326', ...coordinate }, parkType: type },
    })
  })
}

export function parseNewTaipeiParks(text, addressIndex, sourceUpdatedAt) {
  return csvRecords(text).map((row) => {
    const location = locationFromAddress('new-taipei', `${row.area}${row.address}`)
    const name = String(row.name ?? '').trim()
    const address = String(row.address ?? '').normalize('NFKC')
      .replace(/^板橋市/, '')
    const descriptiveLocation = /地號|路口|橋下|旁|對面|斜對面|周邊|前(?:\d+公尺)?|巷內|巷底/.test(address)
    if (!row.seqno || !name || !location || !address.includes('號') || descriptiveLocation) {
      return { excluded: 'invalidCoreFields', city: 'new-taipei' }
    }
    const matched = matchAddress(
      addressIndex,
      address,
      'new-taipei',
      location.districtLabel,
    )
    if (matched.status !== 'matched') {
      return { excluded: `${matched.status}Address`, city: 'new-taipei' }
    }
    return pointFeature({
      source: 'park',
      rawId: row.seqno,
      ...location,
      name,
      coordinate: matched.coordinate,
      sourceUpdatedAt,
      properties: { facilityType: 'park-area', parkType: 'park' },
      evidence: { addressSha256: sha256(address), parkType: 'park' },
    })
  })
}

export async function loadCommunityBoundaries(output) {
  const boundaries = new Map()
  for (const { city, slug } of ALL_DISTRICTS) {
    boundaries.set(
      `${city}/${slug}`,
      JSON.parse(await readFile(join(output, 'boundaries', city, `${slug}.geojson`), 'utf8')),
    )
  }
  return boundaries
}

function qualityFilter(parsed, boundaries) {
  const excluded = {}
  const seenIds = new Set()
  const coordinateCounts = new Map()
  const accepted = []
  for (const item of parsed) {
    if (item.excluded) {
      excluded[item.excluded] = (excluded[item.excluded] ?? 0) + 1
      continue
    }
    const id = item.feature.properties.id
    const coordinateKey = item.feature.geometry.coordinates
      .map((value) => Number(value).toFixed(7)).join(':')
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
    coordinateCounts.set(coordinateKey, (coordinateCounts.get(coordinateKey) ?? 0) + 1)
    accepted.push(item)
  }
  const duplicateCoordinates = [...coordinateCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  if (accepted.length && duplicateCoordinates / accepted.length >= 0.01) {
    throw new Error(`重複點位率 ${(duplicateCoordinates / accepted.length * 100).toFixed(2)}% 未低於 1%`)
  }
  return { accepted, excluded }
}

function addressMatchingRates(parsed) {
  const rates = {}
  for (const city of ['taipei', 'new-taipei']) {
    const eligible = parsed.filter((item) =>
      item.city === city && item.excluded !== 'invalidCoreFields')
    const matched = eligible.filter((item) => !item.excluded)
    rates[city] = eligible.length ? matched.length / eligible.length : 0
  }
  const eligible = parsed.filter((item) => item.excluded !== 'invalidCoreFields')
  rates.overall = eligible.length ? eligible.filter((item) => !item.excluded).length / eligible.length : 0
  return rates
}

function assertMatchingRates(source, rates) {
  for (const [scope, rate] of Object.entries(rates)) {
    if (rate < 0.95) {
      throw new Error(`${source} ${scope} 門牌匹配率 ${(rate * 100).toFixed(2)}% 未達 95%`)
    }
  }
}

function selectSamples(source, items) {
  return Object.fromEntries(['taipei', 'new-taipei'].map((city) => {
    const available = items
      .filter((item) => item.city === city)
      .sort((a, b) => a.feature.properties.id.localeCompare(b.feature.properties.id))
    const selected = []
    if (source === 'school') {
      for (const level of SCHOOL_LEVELS) {
        const item = available.find((candidate) =>
          candidate.feature.properties.schoolLevels.includes(level) &&
          !selected.includes(candidate))
        if (item) selected.push(item)
      }
    } else {
      for (const type of ['park', 'green-space', 'plaza']) {
        const item = available.find((candidate) =>
          candidate.feature.properties.parkType === type &&
          !selected.includes(candidate))
        if (item) selected.push(item)
      }
    }
    selected.push(...available.filter((item) => !selected.includes(item)).slice(0, 5 - selected.length))
    return [city, selected.slice(0, 5).map((item) => ({
      id: item.feature.properties.id,
      city,
      district: item.district,
      sourceRecordId: item.rawId,
      name: item.name,
      longitude: item.coordinate.longitude,
      latitude: item.coordinate.latitude,
      schoolLevels: item.feature.properties.schoolLevels,
      parkType: item.feature.properties.parkType,
      evidence: item.evidence,
    }))]
  }))
}

async function writeSource(generated, source, items, now, sourceSha256, excluded, previous) {
  const grouped = new Map(ALL_DISTRICTS.map(({ city, slug }) => [`${city}/${slug}`, []]))
  for (const item of items) grouped.get(`${item.city}/${item.district}`).push(item.feature)
  const files = []
  for (const [key, features] of grouped) {
    const relative = `${key}/facilities/${source}.geojson`
    await mkdir(dirname(join(generated, relative)), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features })}\n`)
    files.push(relative)
  }
  if (previous?.recordCount > 0 && items.length < previous.recordCount * 0.9) {
    throw new Error(`${source} 筆數較 last-good 異常下降：${previous.recordCount} → ${items.length}`)
  }
  return {
    id: source,
    status: 'official',
    version: `${source}-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: items.length,
    sha256: sourceSha256,
    excluded,
    files,
    adapterVersion: COMMUNITY_ADAPTER_VERSION,
  }
}

async function rawFile(cache, name, url, reuseCache) {
  const directory = join(cache, 'community')
  await mkdir(directory, { recursive: true })
  const file = join(directory, name)
  if (!reuseCache || !await readFile(file).catch(() => null)) await downloadFile(url, file)
  return readFile(file)
}

export async function updateOfficialCommunity({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  reuseCache = false,
  previous = {},
}) {
  const generated = join(cache, 'generated-community')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const boundaries = await loadCommunityBoundaries(output)
  const results = []
  const candidates = {
    adapterVersion: COMMUNITY_ADAPTER_VERSION,
    generatedAt: now.toISOString(),
    addressIndexSha256: {},
    landmarkSha256: null,
    fingerprints: {},
    matchingRates: {},
    samples: {
      school: { taipei: [], 'new-taipei': [] },
      park: { taipei: [], 'new-taipei': [] },
    },
  }
  let indexes
  try {
    const [elementary, junior, senior, special, landmarks] = await Promise.all([
      rawFile(cache, 'elementary.json', SOURCE_URLS.elementarySchool, reuseCache),
      rawFile(cache, 'junior.json', SOURCE_URLS.juniorSchool, reuseCache),
      rawFile(cache, 'senior.json', SOURCE_URLS.seniorSchool, reuseCache),
      rawFile(cache, 'special.csv', SOURCE_URLS.specialSchool, reuseCache),
      rawFile(cache, 'new-taipei-landmarks.json', SOURCE_URLS.newTaipeiLandmarks, reuseCache),
    ])
    indexes = {
      taipei: await buildTaipeiAddressIndex(cache, reuseCache),
      'new-taipei': await buildNewTaipeiAddressIndex(cache, reuseCache),
    }
    candidates.addressIndexSha256 = {
      taipei: indexes.taipei.sha256,
      'new-taipei': indexes['new-taipei'].sha256,
    }
    const landmarkIndex = parseNewTaipeiSchoolLandmarks(jsonBuffer(landmarks))
    candidates.landmarkSha256 = sha256(landmarks)
    const parsed = parseSchools({
      elementary: jsonBuffer(elementary),
      junior: jsonBuffer(junior),
      senior: jsonBuffer(senior),
      special: special.toString('utf8'),
    }, indexes, now.toISOString(), landmarkIndex)
    const rates = addressMatchingRates(parsed)
    candidates.matchingRates.school = rates
    assertMatchingRates('school', rates)
    const merged = mergeSchoolCampuses(parsed)
    const quality = qualityFilter(merged, boundaries)
    const mergedCampusCount = parsed.length - merged.length
    if (mergedCampusCount > 0) quality.excluded.mergedCampus = mergedCampusCount
    const result = await writeSource(
      generated,
      'school',
      quality.accepted,
      now,
      sha256([elementary, junior, senior, special, landmarks].map(sha256).join(':')),
      quality.excluded,
      previous.school,
    )
    result.matchingRate = rates.overall
    result.matchingRates = rates
    result.landmarkSha256 = sha256(landmarks)
    results.push(result)
    candidates.samples.school = selectSamples('school', quality.accepted)
  } catch (error) {
    results.push({ id: 'school', status: 'failed', error: error instanceof Error ? error.message : String(error) })
  }
  try {
    const [taipei, newTaipei] = await Promise.all([
      rawFile(cache, 'taipei-park.json', SOURCE_URLS.taipeiPark, reuseCache),
      rawFile(
        cache,
        'new-taipei-park.csv',
        `${SOURCE_URLS.newTaipeiPark}?page=0&size=100000`,
        reuseCache,
      ),
    ])
    if (!indexes) {
      indexes = {
        taipei: await buildTaipeiAddressIndex(cache, reuseCache),
        'new-taipei': await buildNewTaipeiAddressIndex(cache, reuseCache),
      }
      candidates.addressIndexSha256 = {
        taipei: indexes.taipei.sha256,
        'new-taipei': indexes['new-taipei'].sha256,
      }
    }
    const parsedNewTaipei = parseNewTaipeiParks(
      newTaipei.toString('utf8'),
      indexes['new-taipei'].index,
      now.toISOString(),
    )
    const rates = addressMatchingRates(parsedNewTaipei)
    candidates.matchingRates.park = {
      taipei: 1,
      'new-taipei': rates['new-taipei'],
      overall: rates.overall,
    }
    assertMatchingRates('park', {
      'new-taipei': rates['new-taipei'],
      overall: rates.overall,
    })
    const quality = qualityFilter([
      ...parseTaipeiParks(jsonBuffer(taipei), now.toISOString(), boundaries),
      ...parsedNewTaipei,
    ], boundaries)
    const result = await writeSource(
      generated,
      'park',
      quality.accepted,
      now,
      sha256([sha256(taipei), sha256(newTaipei)].join(':')),
      quality.excluded,
      previous.park,
    )
    result.matchingRate = rates.overall
    result.matchingRates = { taipei: 1, 'new-taipei': rates['new-taipei'], overall: rates.overall }
    results.push(result)
    candidates.samples.park = selectSamples('park', quality.accepted)
  } catch (error) {
    results.push({ id: 'park', status: 'failed', error: error instanceof Error ? error.message : String(error) })
  } finally {
    indexes?.taipei.index.clear()
    indexes?.['new-taipei'].index.clear()
  }
  for (const result of results.filter((item) => item.status === 'official')) {
    candidates.fingerprints[result.id] = {
      sourceSha256: result.sha256,
      datasetSha256: await sourceFilesSha256(generated, result.files),
    }
  }
  await writeFile(
    join(cache, 'community-audit-candidates.json'),
    `${JSON.stringify(candidates, null, 2)}\n`,
  )
  if (!dryRun) {
    for (const result of results.filter((item) => item.status === 'official')) {
      for (const file of result.files) {
        await mkdir(dirname(join(output, file)), { recursive: true })
        await writeFile(join(output, file), await readFile(join(generated, file)))
      }
    }
  }
  return { results, addressIndexSha256: candidates.addressIndexSha256 }
}
