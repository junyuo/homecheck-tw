import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point as turfPoint } from '@turf/helpers'
import {
  csvFileRows,
  downloadFile,
  inTaipeiMetroArea,
  parseCsvLine,
  sha256,
  stableId,
  withRetry,
} from './core.mjs'
import { ALL_DISTRICTS, DISTRICTS, EMPTY_GEOJSON, SOURCE_URLS } from './constants.mjs'
import { sourceFilesSha256 } from './manifest.mjs'

export const RAIL_ADAPTER_VERSION = 'rail-v1'

export function districtFromAddress(address) {
  const city = /新北市/.test(address) ? 'new-taipei' : /[臺台]北市/.test(address) ? 'taipei' : null
  if (!city) return null
  const district = Object.keys(DISTRICTS[city]).find((label) => address.includes(label))
  return district ? { city, district: DISTRICTS[city][district] } : null
}

function point(name, category, longitude, latitude) {
  return {
    type: 'Feature',
    properties: { name, category },
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
  }
}

function segmentDistanceMeters([longitude, latitude], first, second) {
  const longitudeScale = 111000 * Math.cos(latitude * Math.PI / 180)
  const segmentX = (second[0] - first[0]) * longitudeScale
  const segmentY = (second[1] - first[1]) * 111000
  const pointX = (longitude - first[0]) * longitudeScale
  const pointY = (latitude - first[1]) * 111000
  const lengthSquared = segmentX ** 2 + segmentY ** 2
  const ratio = lengthSquared
    ? Math.max(0, Math.min(1, (pointX * segmentX + pointY * segmentY) / lengthSquared))
    : 0
  return Math.hypot(pointX - ratio * segmentX, pointY - ratio * segmentY)
}

function distanceToBoundaryMeters(boundary, coordinate) {
  let nearest = Number.POSITIVE_INFINITY
  function visit(value) {
    if (
      Array.isArray(value) &&
      Array.isArray(value[0]) &&
      typeof value[0][0] === 'number'
    ) {
      for (let index = 1; index < value.length; index += 1) {
        nearest = Math.min(
          nearest,
          segmentDistanceMeters(
            [coordinate.longitude, coordinate.latitude],
            value[index - 1],
            value[index],
          ),
        )
      }
      return
    }
    if (Array.isArray(value)) value.forEach(visit)
  }
  const features = boundary?.type === 'FeatureCollection'
    ? boundary.features
    : boundary?.type === 'Feature'
      ? [boundary]
      : []
  features.forEach((feature) => visit(feature.geometry?.coordinates))
  return nearest
}

export function pointMatchesDistrict(
  boundary,
  { latitude, longitude },
  toleranceMeters = 0,
) {
  const features = boundary?.type === 'FeatureCollection'
    ? boundary.features
    : boundary?.type === 'Feature'
      ? [boundary]
      : []
  const location = turfPoint([longitude, latitude])
  const inside = features.some((feature) =>
    ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type) &&
    booleanPointInPolygon(location, feature))
  return inside ||
    (toleranceMeters > 0 &&
      distanceToBoundaryMeters(boundary, { latitude, longitude }) <= toleranceMeters)
}

async function loadDistrictBoundaries(output) {
  const boundaries = new Map()
  for (const { city, slug } of ALL_DISTRICTS) {
    const key = `${city}/${slug}`
    const file = join(output, 'boundaries', city, `${slug}.geojson`)
    boundaries.set(key, JSON.parse(await readFile(file, 'utf8')))
  }
  return boundaries
}

export function parseRailGps(value) {
  const match = String(value ?? '').trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)$/)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  return inTaipeiMetroArea({ latitude, longitude }) ? { latitude, longitude } : null
}

function railName(value) {
  return String(value ?? '').trim().replace(/-環島$/, '')
}

function distanceMeters(first, second) {
  return Math.hypot(
    (first.latitude - second.latitude) * 111000,
    (first.longitude - second.longitude) * 101000,
  )
}

export function dedupeRailStations(stations) {
  const physical = []
  for (const station of [...stations].sort((a, b) =>
    String(a.stationCode).localeCompare(String(b.stationCode)))) {
    const duplicate = physical.find((item) =>
      item.name === station.name && distanceMeters(item, station) <= 150)
    if (duplicate) {
      duplicate.stationCodes.push(station.stationCode)
      continue
    }
    physical.push({ ...station, stationCodes: [station.stationCode] })
  }
  return physical
}

async function updateMetro(generated, cache, now) {
  const file = join(cache, 'metro.csv')
  await downloadFile(SOURCE_URLS.metro, file)
  const features = new Map(ALL_DISTRICTS.map(({ city, slug }) => [`${city}/${slug}`, []]))
  const seen = new Set()
  let excluded = 0
  for await (const row of csvFileRows(file)) {
    const id = String(row.StationID ?? '').replace(/^'/, '')
    if (!id || seen.has(id)) continue
    const location = districtFromAddress(String(row.StationAddress ?? '').replace(/^'/, ''))
    const coordinate = String(row.StationPosition ?? '').match(/([\d.]+)\s*,\s*([\d.]+)/)
    const nameMatch = String(row.StationName ?? '').match(/\{([^,}]+)/)
    if (!location || !coordinate) {
      excluded += 1
      continue
    }
    const longitude = Number(coordinate[1])
    const latitude = Number(coordinate[2])
    if (!inTaipeiMetroArea({ latitude, longitude })) {
      excluded += 1
      continue
    }
    seen.add(id)
    features.get(`${location.city}/${location.district}`)
      .push(point(nameMatch?.[1] ?? id, 'metro', longitude, latitude))
  }
  const files = []
  for (const [key, items] of features) {
    const relative = `${key}/facilities/metro.geojson`
    await mkdir(join(generated, key, 'facilities'), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features: items })}\n`)
    files.push(relative)
  }
  return {
    id: 'metro',
    status: 'official',
    version: `metro-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: seen.size,
    sha256: sha256(await readFile(file)),
    excluded: { invalidOrUnassigned: excluded },
    files,
  }
}

async function updateNewTaipeiBus(generated, now) {
  const url = `${SOURCE_URLS.newTaipeiBus}?page=0&size=100000`
  const text = await withRetry('new-taipei-bus', async () => {
    const response = await fetch(url, { headers: { 'user-agent': 'homecheck-tw-data-pipeline/1.0' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value = await response.text()
    if (/^\s*</.test(value)) throw new Error('HTML response')
    return value
  })
  const lines = text.split(/\r?\n/).filter(Boolean)
  const headers = parseCsvLine(lines.shift() ?? '').map((value) => value.replace(/^\uFEFF/, ''))
  const features = new Map(Object.values(DISTRICTS['new-taipei']).map((slug) => [slug, []]))
  const seen = new Set()
  let invalid = 0
  for (const line of lines) {
    const values = parseCsvLine(line)
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    const id = String(row.stoplocationid ?? '')
    if (!id || seen.has(id)) continue
    const district = districtFromAddress(row.address)
    const longitude = Number(row.showlon || row.longitude)
    const latitude = Number(row.showlat || row.latitude)
    if (!district || district.city !== 'new-taipei' || !inTaipeiMetroArea({ latitude, longitude })) {
      invalid += 1
      continue
    }
    seen.add(id)
    features.get(district.district).push(point(row.namezh || id, 'bus', longitude, latitude))
  }
  const duplicateRate = lines.length ? (lines.length - seen.size - invalid) / lines.length : 0
  if (duplicateRate < 0 || duplicateRate > 0.99) throw new Error(`公車站位去重比例異常：${duplicateRate}`)
  const files = []
  for (const [district, items] of features) {
    const relative = `new-taipei/${district}/facilities/bus-new-taipei.geojson`
    await mkdir(join(generated, 'new-taipei', district, 'facilities'), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features: items })}\n`)
    files.push(relative)
  }
  return {
    id: 'bus-new-taipei',
    status: 'official',
    version: `bus-new-taipei-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: seen.size,
    sha256: sha256(text),
    excluded: { invalidOrUnassigned: invalid, duplicateRouteStops: lines.length - seen.size - invalid },
    files,
  }
}

async function updateRail(generated, cache, now, previous, boundaryRoot) {
  const file = join(cache, 'rail.json')
  await downloadFile(SOURCE_URLS.rail, file)
  const rows = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(rows)) throw new Error('臺鐵車站來源不是 JSON 陣列')
  const boundaries = await loadDistrictBoundaries(boundaryRoot)
  const candidates = []
  let invalid = 0
  let boundaryToleranceApplied = 0
  for (const row of rows) {
    const stationCode = String(row.stationCode ?? '').trim()
    const name = railName(row.stationName)
    const address = String(row.stationAddrTw ?? '').trim()
    const location = districtFromAddress(address)
    const coordinate = parseRailGps(row.gps)
    const boundary = location
      ? boundaries.get(`${location.city}/${location.district}`)
      : null
    const exactDistrictMatch = coordinate &&
      pointMatchesDistrict(boundary, coordinate)
    const districtMatch = coordinate &&
      pointMatchesDistrict(boundary, coordinate, 20)
    if (
      !stationCode ||
      !name ||
      !location ||
      !coordinate ||
      !districtMatch
    ) {
      if (/[臺台]北市|新北市/.test(address)) invalid += 1
      continue
    }
    if (!exactDistrictMatch) boundaryToleranceApplied += 1
    candidates.push({
      stationCode,
      name,
      address,
      city: location.city,
      district: location.district,
      ...coordinate,
    })
  }
  const stations = dedupeRailStations(candidates)
  const uniqueLocations = new Set(stations.map((station) =>
    `${station.longitude.toFixed(5)}:${station.latitude.toFixed(5)}`))
  if (stations.length < 25 || uniqueLocations.size !== stations.length || invalid > 0) {
    throw new Error(
      `臺鐵品質門檻未通過：${stations.length} 站、重複點 ${stations.length - uniqueLocations.size}、無效 ${invalid}`,
    )
  }
  if (previous?.recordCount > 0 && stations.length < previous.recordCount * 0.9) {
    throw new Error(`臺鐵站數較 last-good 異常下降：${previous.recordCount} → ${stations.length}`)
  }
  const features = new Map(ALL_DISTRICTS.map(({ city, slug }) => [`${city}/${slug}`, []]))
  for (const station of stations) {
    features.get(`${station.city}/${station.district}`).push(
      point(station.name, 'rail', station.longitude, station.latitude),
    )
  }
  const files = []
  for (const [key, items] of features) {
    const relative = `${key}/facilities/rail.geojson`
    await mkdir(join(generated, key, 'facilities'), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({
      ...EMPTY_GEOJSON,
      features: items,
    })}\n`)
    files.push(relative)
  }
  const sourceSha256 = sha256(await readFile(file))
  const auditRows = stations.map((station) => ({
    id: stableId(['rail', ...station.stationCodes]),
    city: station.city,
    district: station.district,
    stationCodes: station.stationCodes,
    name: station.name,
    address: station.address,
    latitude: station.latitude,
    longitude: station.longitude,
  })).sort((a, b) => a.id.localeCompare(b.id))
  await writeFile(join(cache, 'rail-audit-candidates.json'), `${JSON.stringify({
    adapterVersion: RAIL_ADAPTER_VERSION,
    generatedAt: now.toISOString(),
    sourceSha256,
    datasetSha256: await sourceFilesSha256(generated, files),
    samples: {
      taipei: auditRows.filter((item) => item.city === 'taipei'),
      'new-taipei': auditRows.filter((item) => item.city === 'new-taipei').slice(0, 5),
    },
  }, null, 2)}\n`)
  return {
    id: 'rail',
    status: 'official',
    version: `rail-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: stations.length,
    sha256: sourceSha256,
    excluded: {
      invalidOrUnassigned: invalid,
      duplicatePhysicalStations: candidates.length - stations.length,
      boundaryToleranceApplied,
    },
    files,
    adapterVersion: RAIL_ADAPTER_VERSION,
    auditCandidates: stations,
  }
}

export async function updateOfficialTransport({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  previous = {},
}) {
  const generated = join(cache, 'generated-transport')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const results = []
  for (const operation of [
    { id: 'metro', run: () => updateMetro(generated, cache, now) },
    { id: 'bus-new-taipei', run: () => updateNewTaipeiBus(generated, now) },
    { id: 'rail', run: () => updateRail(generated, cache, now, previous.rail, output) },
  ]) {
    try {
      results.push(await operation.run())
    } catch (error) {
      results.push({
        id: operation.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (!dryRun) {
    for (const result of results) {
      if (result.status !== 'official') continue
      for (const file of result.files) {
        await mkdir(dirname(join(output, file)), { recursive: true })
        await writeFile(join(output, file), await readFile(join(generated, file)))
      }
    }
  }
  return results
}
