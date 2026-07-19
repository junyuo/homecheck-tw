import { spawn } from 'node:child_process'
import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { downloadFile, sha256 } from './core.mjs'
import {
  ALL_DISTRICTS,
  DEFAULT_FLOOD_SCENARIO,
  EMPTY_GEOJSON,
  FLOOD_SCENARIOS,
  SOURCE_URLS,
} from './constants.mjs'

const FLOOD_UPDATED_AT = '2022-08-12T00:00:00.000Z'
const FLOOD_VALID_UNTIL = '2027-08-12T00:00:00.000Z'
const BOUNDARY_UPDATED_AT = '2025-03-18T00:00:00.000Z'
const LIQUEFACTION_UPDATED_AT = '2024-08-08T02:24:00.000Z'
const MAX_INVALID_DEPTH_RATE = 0.02
export const RISK_ADAPTER_VERSION = 'risks-v1'

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} ${args.join(' ')}: ${stderr || code}`))
    })
  })
}

export async function assertGdal() {
  const version = (await run('ogr2ogr', ['--version'])).trim()
  if (!/^GDAL \d/.test(version)) throw new Error(`無法辨識 GDAL：${version}`)
  return version
}

async function downloadResource(url, destination, reuseCache) {
  await mkdir(dirname(destination), { recursive: true })
  if (reuseCache) {
    await access(destination).catch(() => downloadFile(url, destination))
  } else {
    await downloadFile(url, destination)
  }
  const value = await readFile(destination)
  if (!value.length) throw new Error(`${destination} 是空檔`)
  return { file: destination, hash: sha256(value) }
}

async function readGeoJson(file) {
  const text = await readFile(file, 'utf8')
  if (/^\s*</.test(text)) throw new Error(`${file} 是 HTML，不是 GeoJSON`)
  const value = JSON.parse(text)
  if (value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new Error(`${file} 不是 FeatureCollection`)
  }
  return value
}

async function writeGeoJson(file, collection) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(collection)}\n`)
}

export function validateShapefileEntries(entries, archive = 'archive.zip') {
  const shapefiles = entries.filter((entry) => /\.shp$/i.test(entry))
  if (shapefiles.length !== 1) {
    throw new Error(`${archive} 應包含 1 個 SHP，實際為 ${shapefiles.length}`)
  }
  const stem = shapefiles[0].replace(/\.shp$/i, '')
  for (const extension of ['dbf', 'prj', 'shx']) {
    if (!entries.some((entry) => entry.toLowerCase() === `${stem}.${extension}`.toLowerCase())) {
      throw new Error(`${archive} 缺少 ${extension.toUpperCase()}`)
    }
  }
  return shapefiles[0]
}

async function shapefileInArchive(archive) {
  const entries = (await run('unzip', ['-Z1', archive]))
    .split(/\r?\n/)
    .filter(Boolean)
  return `/vsizip/${resolve(archive)}/${validateShapefileEntries(entries, archive)}`
}

function districtName(city, label) {
  return city === 'taipei'
    ? { county: '臺北市', town: label }
    : { county: '新北市', town: label }
}

async function makeBoundaries(rawZip, generated) {
  const all = join(generated, '_working', 'boundaries.geojson')
  await mkdir(dirname(all), { recursive: true })
  await rm(all, { force: true })
  await run('ogr2ogr', [
    '-f', 'GeoJSON',
    '-nln', 'boundaries',
    '-lco', 'RFC7946=YES',
    '-lco', 'COORDINATE_PRECISION=6',
    '-t_srs', 'EPSG:4326',
    '-makevalid',
    '-where', "COUNTYNAME IN ('臺北市','新北市')",
    all,
    `/vsizip/${resolve(rawZip)}`,
    'TOWN_MOI_1140318',
  ])

  const boundaries = new Map()
  const files = []
  for (const district of ALL_DISTRICTS) {
    const names = districtName(district.city, district.label)
    const relative = `boundaries/${district.city}/${district.slug}.geojson`
    const destination = join(generated, relative)
    await mkdir(dirname(destination), { recursive: true })
    await rm(destination, { force: true })
    await run('ogr2ogr', [
      '-f', 'GeoJSON',
      '-nln', 'boundary',
      '-lco', 'RFC7946=YES',
      '-lco', 'COORDINATE_PRECISION=6',
      '-makevalid',
      '-where', `COUNTYNAME = '${names.county}' AND TOWNNAME = '${names.town}'`,
      destination,
      all,
    ])
    const collection = await readGeoJson(destination)
    if (collection.features.length !== 1) {
      throw new Error(`${names.county}${names.town} 行政區界數量為 ${collection.features.length}`)
    }
    boundaries.set(`${district.city}/${district.slug}`, destination)
    files.push(relative)
  }
  return { boundaries, files }
}

export function floodDepthLevel(value) {
  const category = String(value ?? '').trim()
  if (category === '0.3-0.5') return 'attention'
  if (['0.5-1.0', '1.0-2.0', '2.0-3.0', '>3.0'].includes(category)) return 'priority'
  return null
}

export function liquefactionClassLevel(value) {
  return ({ '1': 'priority', '2': 'attention', '3': 'low' })[String(value ?? '').trim()] ?? null
}

export function assertDepthQuality(total, invalid, scenario) {
  const invalidRate = total ? invalid / total : 1
  if (invalidRate > MAX_INVALID_DEPTH_RATE) {
    throw new Error(`${scenario} 未知深度級距 ${(invalidRate * 100).toFixed(2)}% 超過 2%`)
  }
  return invalidRate
}

function normalizedRiskFeature(feature, properties) {
  if (!feature?.geometry) return null
  return {
    type: 'Feature',
    properties: {
      name: properties.riskType === 'flood' ? '淹水潛勢' : '土壤液化潛勢',
      sourceType: 'official',
      coverageConfirmed: false,
      ...properties,
    },
    geometry: feature.geometry,
  }
}

export function polygonGeometries(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return [geometry]
  }
  if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries ?? []).flatMap(polygonGeometries)
  }
  return []
}

async function clipLayer(input, boundary, destination) {
  await mkdir(dirname(destination), { recursive: true })
  await rm(destination, { force: true })
  await run('ogr2ogr', [
    '-f', 'GeoJSON',
    '-nln', 'risk',
    '-lco', 'RFC7946=YES',
    '-lco', 'COORDINATE_PRECISION=6',
    '-makevalid',
    '-simplify', '0.00001',
    '-clipsrc', boundary,
    destination,
    input,
  ])
  const value = await readGeoJson(destination)
  const features = value.features.flatMap((feature) =>
    polygonGeometries(feature.geometry).map((geometry) => ({
      ...feature,
      geometry,
    })))
  await writeGeoJson(destination, { ...EMPTY_GEOJSON, features })
  const size = (await stat(destination)).size
  if (size > 5 * 1024 * 1024) throw new Error(`${destination} 超過 5 MB`)
  return features.length
}

async function buildFlood(
  resources,
  generated,
  boundaries,
  now,
) {
  const files = []
  const excluded = { invalidDepthCategory: 0 }
  let sourceFeatures = 0
  let outputFeatures = 0

  for (const scenario of FLOOD_SCENARIOS) {
    const raw = resources.get(scenario.id)
    const shapefile = await shapefileInArchive(raw.file)
    const converted = join(generated, '_working', `flood-${scenario.id}-raw.geojson`)
    await rm(converted, { force: true })
    await run('ogr2ogr', [
      '-f', 'GeoJSON',
      '-nln', 'flood',
      '-lco', 'RFC7946=YES',
      '-lco', 'COORDINATE_PRECISION=6',
      '-t_srs', 'EPSG:4326',
      '-makevalid',
      '-where', "CityName IN ('臺北市','新北市')",
      converted,
      shapefile,
    ])
    const collection = await readGeoJson(converted)
    const features = []
    for (const feature of collection.features) {
      const officialCategory = String(feature.properties?.flood_dept ?? '').trim()
      const level = floodDepthLevel(officialCategory)
      if (!level) {
        excluded.invalidDepthCategory += 1
        continue
      }
      features.push(normalizedRiskFeature(feature, {
        riskType: 'flood',
        level,
        officialCategory,
        scenario: scenario.id,
        durationHours: scenario.durationHours,
        rainfallMm: scenario.rainfallMm,
        updatedAt: FLOOD_UPDATED_AT,
      }))
    }
    assertDepthQuality(
      collection.features.length,
      collection.features.length - features.length,
      scenario.id,
    )
    if (!features.length) throw new Error(`${scenario.id} 沒有雙北淹水圖徵`)
    sourceFeatures += features.length
    const normalized = join(generated, '_working', `flood-${scenario.id}.geojson`)
    await writeGeoJson(normalized, { ...EMPTY_GEOJSON, features })

    for (const district of ALL_DISTRICTS) {
      const key = `${district.city}/${district.slug}`
      const relative = `${key}/risks/flood/${scenario.id}.geojson`
      outputFeatures += await clipLayer(
        normalized,
        boundaries.get(key),
        join(generated, relative),
      )
      files.push(relative)
    }
  }

  return {
    id: 'flood',
    status: 'official',
    version: `flood-2022-08-12-${sha256([...resources.values()].map((item) => item.hash).join(':')).slice(0, 8)}`,
    updatedAt: FLOOD_UPDATED_AT,
    metadataCheckedAt: now.toISOString(),
    validUntil: FLOOD_VALID_UNTIL,
    recordCount: sourceFeatures,
    outputFeatureCount: outputFeatures,
    sha256: sha256([...resources.values()].map((item) => item.hash).join(':')),
    excluded,
    files,
    scenarios: FLOOD_SCENARIOS.map((item) => item.id),
    defaultScenario: DEFAULT_FLOOD_SCENARIO,
  }
}

async function buildLiquefaction(
  taipeiResource,
  centralResources,
  generated,
  boundaries,
  now,
) {
  const taipei = await readGeoJson(taipeiResource.file)
  const taipeiFeatures = []
  let invalidClass = 0
  for (const feature of taipei.features) {
    const officialClass = String(feature.properties?.class ?? '').trim()
    const level = liquefactionClassLevel(officialClass)
    if (!level) {
      invalidClass += 1
      continue
    }
    taipeiFeatures.push(normalizedRiskFeature(feature, {
      riskType: 'liquefaction',
      level,
      officialCategory: ({ '1': '高潛勢', '2': '中潛勢', '3': '低潛勢' })[officialClass],
      updatedAt: taipeiResource.updatedAt,
    }))
  }
  if (invalidClass || !taipeiFeatures.length) {
    throw new Error(`臺北液化圖資含 ${invalidClass} 筆未知 class`)
  }

  const newTaipeiFeatures = []
  for (const [officialCategory, resource] of centralResources) {
    const collection = await readGeoJson(resource.file)
    const level = ({ 低潛勢: 'low', 中潛勢: 'attention', 高潛勢: 'priority' })[officialCategory]
    for (const feature of collection.features) {
      newTaipeiFeatures.push(normalizedRiskFeature(feature, {
        riskType: 'liquefaction',
        level,
        officialCategory,
        updatedAt: resource.updatedAt,
      }))
    }
  }
  if (!newTaipeiFeatures.length) throw new Error('中央液化 API 沒有圖徵')

  const taipeiFile = join(generated, '_working', 'liquefaction-taipei.geojson')
  const newTaipeiFile = join(generated, '_working', 'liquefaction-new-taipei.geojson')
  await writeGeoJson(taipeiFile, { ...EMPTY_GEOJSON, features: taipeiFeatures })
  await writeGeoJson(newTaipeiFile, { ...EMPTY_GEOJSON, features: newTaipeiFeatures })

  const files = []
  let outputFeatures = 0
  for (const district of ALL_DISTRICTS) {
    const key = `${district.city}/${district.slug}`
    const relative = `${key}/risks/liquefaction.geojson`
    outputFeatures += await clipLayer(
      district.city === 'taipei' ? taipeiFile : newTaipeiFile,
      boundaries.get(key),
      join(generated, relative),
    )
    files.push(relative)
  }
  const combinedHash = sha256([
    taipeiResource.hash,
    ...[...centralResources.values()].map((item) => item.hash),
  ].join(':'))
  return {
    id: 'liquefaction',
    status: 'official',
    version: `liquefaction-2024-08-08-${combinedHash.slice(0, 8)}`,
    updatedAt: LIQUEFACTION_UPDATED_AT,
    metadataCheckedAt: now.toISOString(),
    validUntil: null,
    recordCount: taipeiFeatures.length + newTaipeiFeatures.length,
    outputFeatureCount: outputFeatures,
    sha256: combinedHash,
    excluded: { invalidClass },
    files,
  }
}

export async function updateOfficialRisks({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  reuseCache = false,
  previous = null,
  forceRebuild = false,
}) {
  const gdalVersion = await assertGdal()
  const riskCache = join(cache, 'risks')
  const generated = join(cache, 'generated-risks')

  const boundaryResource = await downloadResource(
    SOURCE_URLS.districtBoundary,
    join(riskCache, 'district-boundary.zip'),
    reuseCache,
  )
  const floodResources = new Map()
  for (const scenario of FLOOD_SCENARIOS) {
    floodResources.set(scenario.id, await downloadResource(
      SOURCE_URLS.flood(`${scenario.rainfallMm}-${scenario.durationHours}hr`),
      join(riskCache, `flood-${scenario.id}.zip`),
      reuseCache,
    ))
  }
  const taipeiLiquefaction = await downloadResource(
    SOURCE_URLS.taipeiLiquefaction,
    join(riskCache, 'liquefaction-taipei.geojson'),
    reuseCache,
  )
  taipeiLiquefaction.updatedAt = '2020-10-15T02:18:00.000Z'
  const centralLiquefaction = new Map()
  for (const classification of ['低潛勢', '中潛勢', '高潛勢']) {
    const resource = await downloadResource(
      SOURCE_URLS.liquefaction(classification),
      join(riskCache, `liquefaction-${classification}.geojson`),
      reuseCache,
    )
    resource.updatedAt = LIQUEFACTION_UPDATED_AT
    centralLiquefaction.set(classification, resource)
  }

  const floodHash = sha256(
    [...floodResources.values()].map((item) => item.hash).join(':'),
  )
  const liquefactionHash = sha256([
    taipeiLiquefaction.hash,
    ...[...centralLiquefaction.values()].map((item) => item.hash),
  ].join(':'))
  const unchanged = !forceRebuild && previous &&
    previous.boundary?.sha256 === boundaryResource.hash &&
    previous.flood?.sha256 === floodHash &&
    previous.liquefaction?.sha256 === liquefactionHash
  if (unchanged) {
    const checkedAt = now.toISOString()
    return {
      adapterVersion: RISK_ADAPTER_VERSION,
      gdalVersion,
      unchanged: true,
      boundary: { ...previous.boundary, metadataCheckedAt: checkedAt },
      flood: { ...previous.flood, metadataCheckedAt: checkedAt },
      liquefaction: { ...previous.liquefaction, metadataCheckedAt: checkedAt },
      generated: null,
    }
  }

  await rm(generated, { recursive: true, force: true })
  await mkdir(join(generated, '_working'), { recursive: true })
  const boundaryOutput = await makeBoundaries(boundaryResource.file, generated)
  const flood = await buildFlood(floodResources, generated, boundaryOutput.boundaries, now)
  const liquefaction = await buildLiquefaction(
    taipeiLiquefaction,
    centralLiquefaction,
    generated,
    boundaryOutput.boundaries,
    now,
  )
  const boundary = {
    id: 'district-boundary',
    status: 'official',
    version: `district-boundary-2025-03-18-${boundaryResource.hash.slice(0, 8)}`,
    updatedAt: BOUNDARY_UPDATED_AT,
    metadataCheckedAt: now.toISOString(),
    validUntil: null,
    recordCount: ALL_DISTRICTS.length,
    sha256: boundaryResource.hash,
    excluded: {},
    files: boundaryOutput.files,
  }

  if (!dryRun) {
    for (const district of ALL_DISTRICTS) {
      await rm(join(output, district.city, district.slug, 'risks'), { recursive: true, force: true })
    }
    await rm(join(output, 'boundaries'), { recursive: true, force: true })
    await cp(generated, output, {
      recursive: true,
      filter: (source) => !source.includes(`${join(generated, '_working')}`),
    })
  }
  return {
    adapterVersion: RISK_ADAPTER_VERSION,
    gdalVersion,
    boundary,
    flood,
    liquefaction,
    generated,
  }
}
