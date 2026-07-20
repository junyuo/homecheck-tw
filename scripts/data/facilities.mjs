import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildNewTaipeiAddressIndex,
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

export const FACILITIES_ADAPTER_VERSION = 'facilities-v1'

function csvRecords(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim())
  const headers = parseCsvLine(lines.shift() ?? '').map((value) => value.replace(/^\uFEFF/, ''))
  return lines.map((line) => {
    const values = parseCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

function districtLocation(city, label) {
  const district = DISTRICTS[city]?.[String(label ?? '').trim()]
  return district ? { city, district, districtLabel: String(label).trim() } : null
}

function facility({
  rawId,
  city,
  district,
  name,
  category,
  facilityType,
  coordinate,
  sourceUpdatedAt,
  carCapacity,
  evidence,
}) {
  return {
    rawId: String(rawId).trim(),
    city,
    district,
    name: String(name).trim(),
    coordinate,
    evidence,
    feature: {
      type: 'Feature',
      properties: {
        id: stableId([category, city, rawId]),
        name: String(name).trim(),
        category,
        facilityType,
        sourceUpdatedAt,
        ...(Number.isInteger(carCapacity) ? { carCapacity } : {}),
      },
      geometry: {
        type: 'Point',
        coordinates: [coordinate.longitude, coordinate.latitude],
      },
    },
  }
}

export function parseTaipeiParking(value, sourceUpdatedAt) {
  const rows = value?.data?.park
  if (!Array.isArray(rows)) throw new Error('臺北停車來源缺少 data.park 陣列')
  return rows.map((row) => {
    const location = districtLocation('taipei', row.area)
    const carCapacity = Number(row.totalcar)
    const coordinate = twd97ToWgs84(row.tw97x, row.tw97y)
    if (!row.id || !String(row.name ?? '').trim() || !location || !(carCapacity > 0) || !coordinate) {
      return { excluded: 'invalidCoreFields' }
    }
    return facility({
      rawId: row.id,
      ...location,
      name: row.name,
      category: 'parking',
      facilityType: 'offstreet-parking',
      coordinate,
      sourceUpdatedAt,
      carCapacity: Math.trunc(carCapacity),
      evidence: {
        rawCoordinate: { crs: 'EPSG:3826', x: Number(row.tw97x), y: Number(row.tw97y) },
      },
    })
  })
}

export function parseNewTaipeiParking(text, sourceUpdatedAt) {
  return csvRecords(text).map((row) => {
    const location = districtLocation('new-taipei', row.AREA)
    const carCapacity = Number(row.TOTALCAR)
    const coordinate = twd97ToWgs84(row.TW97X, row.TW97Y)
    if (!row.ID || !String(row.NAME ?? '').trim() || !location || !(carCapacity > 0) || !coordinate) {
      return { excluded: 'invalidCoreFields' }
    }
    return facility({
      rawId: row.ID,
      ...location,
      name: row.NAME,
      category: 'parking',
      facilityType: 'offstreet-parking',
      coordinate,
      sourceUpdatedAt,
      carCapacity: Math.trunc(carCapacity),
      evidence: {
        rawCoordinate: { crs: 'EPSG:3826', x: Number(row.TW97X), y: Number(row.TW97Y) },
      },
    })
  })
}

export function parseTaipeiHospitals(buffer, sourceUpdatedAt) {
  const text = new TextDecoder('big5').decode(buffer)
  return csvRecords(text).map((row, index) => {
    const address = String(row['地址'] ?? '')
    const districtLabel = Object.keys(DISTRICTS.taipei).find((label) => address.includes(label))
    const location = districtLocation('taipei', districtLabel)
    const coordinate = {
      longitude: Number(row['經度']),
      latitude: Number(row['緯度']),
    }
    if (!String(row['機構名稱'] ?? '').trim() || !location || !inTaipeiMetroArea(coordinate)) {
      return { excluded: 'invalidCoreFields' }
    }
    const rawId = stableId(['taipei-hospital', row['機構名稱'], index])
    return facility({
      rawId,
      ...location,
      name: row['機構名稱'],
      category: 'medical',
      facilityType: 'hospital',
      coordinate,
      sourceUpdatedAt,
      evidence: {
        rawCoordinate: { crs: 'EPSG:4326', ...coordinate },
      },
    })
  })
}

export function parseNewTaipeiHospitals(text, addressIndex, sourceUpdatedAt) {
  return csvRecords(text).map((row) => {
    const location = districtLocation('new-taipei', row.area)
    if (!row.hosp_id || !String(row.hosp_name ?? '').trim() || !location) {
      return { excluded: 'invalidCoreFields', city: 'new-taipei' }
    }
    const address = String(row.hosp_addr ?? '').normalize('NFKC')
    const firstHouseNumber = address.slice(0, Math.max(0, address.indexOf('號') + 1))
    const multipleAddress = (address.match(/號/g) ?? []).length > 1 ||
      /[0-9零〇一二兩三四五六七八九十][、．.,，][0-9零〇一二兩三四五六七八九十]/.test(firstHouseNumber) ||
      /號及.*(?:路|街|大道)/.test(address)
    if (multipleAddress) {
      return { excluded: 'multipleAddress', city: 'new-taipei' }
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
    return facility({
      rawId: row.hosp_id,
      ...location,
      name: row.hosp_name,
      category: 'medical',
      facilityType: 'hospital',
      coordinate: matched.coordinate,
      sourceUpdatedAt,
      evidence: {
        addressSha256: sha256(String(row.hosp_addr)),
      },
    })
  })
}

async function loadBoundaries(output) {
  const boundaries = new Map()
  for (const { city, slug } of ALL_DISTRICTS) {
    const file = join(output, 'boundaries', city, `${slug}.geojson`)
    boundaries.set(`${city}/${slug}`, JSON.parse(await readFile(file, 'utf8')))
  }
  return boundaries
}

function qualityFilter(parsed, boundaries) {
  const excluded = {}
  const seenIds = new Set()
  const seenCoordinates = new Set()
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
    if (seenCoordinates.has(coordinateKey)) {
      excluded.duplicateCoordinate = (excluded.duplicateCoordinate ?? 0) + 1
      continue
    }
    const boundary = boundaries.get(`${item.city}/${item.district}`)
    if (!inTaipeiMetroArea(item.coordinate) || !pointMatchesDistrict(boundary, item.coordinate)) {
      excluded.districtMismatch = (excluded.districtMismatch ?? 0) + 1
      continue
    }
    seenIds.add(id)
    seenCoordinates.add(coordinateKey)
    accepted.push(item)
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
        city: item.city,
        district: item.district,
        sourceRecordId: item.rawId,
        name: item.name,
        longitude: item.coordinate.longitude,
        latitude: item.coordinate.latitude,
        ...(Number.isInteger(item.feature.properties.carCapacity)
          ? { carCapacity: item.feature.properties.carCapacity }
          : {}),
        evidence: item.evidence,
      })),
  ]))
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
    adapterVersion: FACILITIES_ADAPTER_VERSION,
  }
}

async function rawFile(cache, name, url, reuseCache) {
  const directory = join(cache, 'facilities')
  await mkdir(directory, { recursive: true })
  const file = join(directory, name)
  if (!reuseCache || !await readFile(file).catch(() => null)) {
    await downloadFile(url, file)
  }
  return readFile(file)
}

export async function updateOfficialFacilities({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  reuseCache = false,
  previous = {},
}) {
  const generated = join(cache, 'generated-facilities')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const boundaries = await loadBoundaries(output)
  const results = []
  const candidates = {
    adapterVersion: FACILITIES_ADAPTER_VERSION,
    generatedAt: now.toISOString(),
    addressIndexSha256: null,
    fingerprints: {},
    samples: {
      parking: { taipei: [], 'new-taipei': [] },
      medical: { taipei: [], 'new-taipei': [] },
    },
  }
  let matchingRate = null
  try {
    const [taipei, newTaipei] = await Promise.all([
      rawFile(cache, 'taipei-parking.json', SOURCE_URLS.taipeiParking, reuseCache),
      rawFile(
        cache,
        'new-taipei-parking.csv',
        `${SOURCE_URLS.newTaipeiParking}?page=0&size=100000`,
        reuseCache,
      ),
    ])
    const quality = qualityFilter([
      ...parseTaipeiParking(JSON.parse(taipei.toString('utf8')), now.toISOString()),
      ...parseNewTaipeiParking(newTaipei.toString('utf8'), now.toISOString()),
    ], boundaries)
    const result = await writeSource(
      generated,
      'parking',
      quality.accepted,
      now,
      sha256([sha256(taipei), sha256(newTaipei)].join(':')),
      quality.excluded,
      previous.parking,
    )
    results.push(result)
    candidates.samples.parking = selectSamples(quality.accepted)
  } catch (error) {
    results.push({
      id: 'parking',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
  let newTaipeiAddress
  try {
    const [taipei, newTaipei] = await Promise.all([
      rawFile(cache, 'taipei-hospital.csv', SOURCE_URLS.taipeiHospital, reuseCache),
      rawFile(cache, 'new-taipei-hospital.csv', SOURCE_URLS.newTaipeiHospital, reuseCache),
    ])
    newTaipeiAddress = await buildNewTaipeiAddressIndex(cache, reuseCache)
    candidates.addressIndexSha256 = newTaipeiAddress.sha256
    const parsedNewTaipei = parseNewTaipeiHospitals(
      newTaipei.toString('utf8'),
      newTaipeiAddress.index,
      now.toISOString(),
    )
    const eligible = parsedNewTaipei.filter((item) =>
      !['invalidCoreFields', 'multipleAddress'].includes(item.excluded)).length
    const matched = parsedNewTaipei.filter((item) => !item.excluded).length
    matchingRate = eligible ? matched / eligible : 0
    if (matchingRate < 0.95) {
      throw new Error(`新北醫院門牌匹配率 ${(matchingRate * 100).toFixed(2)}% 未達 95%`)
    }
    const quality = qualityFilter([
      ...parseTaipeiHospitals(taipei, now.toISOString()),
      ...parsedNewTaipei,
    ], boundaries)
    const result = await writeSource(
      generated,
      'medical',
      quality.accepted,
      now,
      sha256([sha256(taipei), sha256(newTaipei)].join(':')),
      quality.excluded,
      previous.medical,
    )
    results.push(result)
    candidates.samples.medical = selectSamples(quality.accepted)
  } catch (error) {
    results.push({
      id: 'medical',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    newTaipeiAddress?.index.clear()
  }
  for (const result of results.filter((item) => item.status === 'official')) {
    candidates.fingerprints[result.id] = {
      sourceSha256: result.sha256,
      datasetSha256: await sourceFilesSha256(generated, result.files),
    }
  }
  await writeFile(
    join(cache, 'facility-audit-candidates.json'),
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
  return {
    results,
    matchingRate,
    addressIndexSha256: candidates.addressIndexSha256,
  }
}
