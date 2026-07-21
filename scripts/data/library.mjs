import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { downloadFile, inTaipeiMetroArea, sha256, stableId } from './core.mjs'
import { ALL_DISTRICTS, DISTRICTS, EMPTY_GEOJSON, SOURCE_URLS } from './constants.mjs'
import { sourceFilesSha256 } from './manifest.mjs'
import { pointMatchesDistrict } from './transport.mjs'

export const LIBRARY_ADAPTER_VERSION = 'library-v1'

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replaceAll('台', '臺').replace(/\s+/g, '')
}

function districtLocation(city, area, address) {
  const areaLabel = normalizeText(area)
  const addressText = normalizeText(address)
  const districtLabel = Object.keys(DISTRICTS[city] ?? {})
    .find((label) => areaLabel === label && addressText.includes(label))
  const district = DISTRICTS[city]?.[districtLabel]
  return district ? { city, district, districtLabel } : null
}

export function parseLibraries(value, sourceUpdatedAt) {
  if (!Array.isArray(value)) throw new Error('公共圖書館來源不是陣列')
  const parsed = []
  for (const group of value) {
    const cityLabel = normalizeText(group?.['縣市'])
    const city = cityLabel === '臺北市' ? 'taipei' : cityLabel === '新北市' ? 'new-taipei' : null
    if (!city) continue
    if (!Array.isArray(group?.['圖書館資訊'])) throw new Error(`${cityLabel} 缺少圖書館資訊陣列`)
    for (const row of group['圖書館資訊']) {
      const name = String(row.Name ?? '').trim()
      const address = normalizeText(row.Address)
      const location = districtLocation(city, row.Area, address)
      const coordinate = { longitude: Number(row.Longitude), latitude: Number(row.Latitude) }
      if (!name || !address || !location || !inTaipeiMetroArea(coordinate)) {
        parsed.push({ excluded: 'invalidCoreFields', city })
        continue
      }
      const addressSha256 = sha256(address)
      const rawId = stableId([city, normalizeText(name), addressSha256])
      parsed.push({
        rawId,
        ...location,
        name,
        coordinate,
        evidence: {
          rawCoordinate: { crs: 'EPSG:4326', ...coordinate },
          addressSha256,
        },
        feature: {
          type: 'Feature',
          properties: {
            id: stableId(['library', rawId]),
            name,
            category: 'library',
            facilityType: 'public-library',
            sourceUpdatedAt,
          },
          geometry: { type: 'Point', coordinates: [coordinate.longitude, coordinate.latitude] },
        },
      })
    }
  }
  return parsed
}

export function qualityLibraries(parsed, boundaries) {
  const excluded = {}
  const accepted = []
  const identities = new Map()
  const coordinateCounts = new Map()
  for (const item of parsed) {
    if (item.excluded) {
      excluded[item.excluded] = (excluded[item.excluded] ?? 0) + 1
      continue
    }
    const identity = item.feature.properties.id
    const previous = identities.get(identity)
    if (previous) {
      const distance = Math.hypot(
        (previous.coordinate.latitude - item.coordinate.latitude) * 111000,
        (previous.coordinate.longitude - item.coordinate.longitude) * 101000,
      )
      excluded[distance <= 1 ? 'mergedDuplicate' : 'conflictingDuplicate'] =
        (excluded[distance <= 1 ? 'mergedDuplicate' : 'conflictingDuplicate'] ?? 0) + 1
      continue
    }
    const boundary = boundaries.get(`${item.city}/${item.district}`)
    if (!pointMatchesDistrict(boundary, item.coordinate)) {
      excluded.districtMismatch = (excluded.districtMismatch ?? 0) + 1
      continue
    }
    identities.set(identity, item)
    const key = `${item.coordinate.longitude.toFixed(7)}:${item.coordinate.latitude.toFixed(7)}`
    coordinateCounts.set(key, (coordinateCounts.get(key) ?? 0) + 1)
    accepted.push(item)
  }
  const duplicatePoints = [...coordinateCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  if (accepted.length && duplicatePoints / accepted.length >= 0.01) {
    throw new Error(`library 重複點位率 ${(duplicatePoints / accepted.length * 100).toFixed(2)}% 未低於 1%`)
  }
  return { accepted, excluded }
}

function selectSamples(items) {
  return Object.fromEntries(['taipei', 'new-taipei'].map((city) => {
    const available = items.filter((item) => item.city === city)
      .sort((a, b) => a.feature.properties.id.localeCompare(b.feature.properties.id))
    const selected = []
    for (const district of [...new Set(available.map((item) => item.district))]) {
      const item = available.find((candidate) => candidate.district === district)
      if (item) selected.push(item)
      if (selected.length >= 3) break
    }
    selected.push(...available.filter((item) => !selected.includes(item)).slice(0, 5 - selected.length))
    return [city, selected.slice(0, 5).map((item) => ({
      id: item.feature.properties.id,
      source: 'library',
      city,
      district: item.district,
      sourceRecordId: item.rawId,
      name: item.name,
      longitude: item.coordinate.longitude,
      latitude: item.coordinate.latitude,
      evidence: item.evidence,
    }))]
  }))
}

async function loadBoundaries(output) {
  const boundaries = new Map()
  for (const { city, slug } of ALL_DISTRICTS) {
    boundaries.set(`${city}/${slug}`, JSON.parse(await readFile(
      join(output, 'boundaries', city, `${slug}.geojson`), 'utf8',
    )))
  }
  return boundaries
}

export async function updateOfficialLibraries({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  reuseCache = false,
  previous,
}) {
  const rawDirectory = join(cache, 'library')
  const rawFile = join(rawDirectory, 'public-libraries.json')
  await mkdir(rawDirectory, { recursive: true })
  if (!reuseCache || !await readFile(rawFile).catch(() => null)) {
    await downloadFile(SOURCE_URLS.publicLibraries, rawFile)
  }
  const raw = await readFile(rawFile)
  let value
  try {
    value = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('公共圖書館來源不是有效 JSON')
  }
  const boundaries = await loadBoundaries(output)
  const quality = qualityLibraries(parseLibraries(value, now.toISOString()), boundaries)
  if (!quality.accepted.length) throw new Error('公共圖書館來源沒有雙北有效點位')
  if (previous?.recordCount > 0 && quality.accepted.length < previous.recordCount * 0.9) {
    throw new Error(`library 筆數較 last-good 異常下降：${previous.recordCount} → ${quality.accepted.length}`)
  }
  const generated = join(cache, 'generated-library')
  await rm(generated, { recursive: true, force: true })
  const grouped = new Map(ALL_DISTRICTS.map(({ city, slug }) => [`${city}/${slug}`, []]))
  for (const item of quality.accepted) grouped.get(`${item.city}/${item.district}`).push(item.feature)
  const files = []
  for (const [key, features] of grouped) {
    const relative = `${key}/facilities/library.geojson`
    await mkdir(dirname(join(generated, relative)), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features })}\n`)
    files.push(relative)
  }
  if (!dryRun) {
    for (const file of files) {
      await mkdir(dirname(join(output, file)), { recursive: true })
      await writeFile(join(output, file), await readFile(join(generated, file)))
    }
  }
  const sourceSha256 = sha256(raw)
  const result = {
    id: 'library',
    status: 'official',
    version: `library-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: quality.accepted.length,
    sha256: sourceSha256,
    excluded: quality.excluded,
    files,
    adapterVersion: LIBRARY_ADAPTER_VERSION,
  }
  const candidates = {
    adapterVersion: LIBRARY_ADAPTER_VERSION,
    generatedAt: now.toISOString(),
    fingerprints: {
      sourceSha256,
      datasetSha256: await sourceFilesSha256(generated, files),
    },
    samples: selectSamples(quality.accepted),
  }
  await writeFile(join(cache, 'library-audit-candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`)
  return result
}
