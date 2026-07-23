import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ALL_DISTRICTS } from './constants.mjs'

async function walk(directory) {
  const result = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const item = await stat(path)
    if (item.isDirectory()) result.push(...await walk(path))
    else result.push(path)
  }
  return result
}

function validateCoordinates(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false
  if (coordinates.length >= 2 && coordinates.every(Number.isFinite)) {
    const [longitude, latitude] = coordinates
    return longitude >= 121.28 && longitude <= 122.02 && latitude >= 24.65 && latitude <= 25.32
  }
  return coordinates.every(validateCoordinates)
}

export async function validateData(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== '2.0.0' || manifest.mode !== 'production') {
    throw new Error('manifest 必須是 production schema v2')
  }
  const files = await walk(directory)
  const relativeFiles = new Set(files.map((file) => file.slice(directory.length + 1)))
  const jsonFiles = files.filter((file) => file.endsWith('.json') || file.endsWith('.geojson'))
  for (const file of jsonFiles) {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (file.endsWith('.geojson') || file.includes('/accidents/')) {
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        throw new Error(`${file} 不是 FeatureCollection`)
      }
      for (const feature of data.features) {
        if (!feature.geometry || !validateCoordinates(feature.geometry.coordinates)) {
          throw new Error(`${file} 含空 geometry 或雙北範圍外座標`)
        }
        if (file.includes('/accidents/')) {
          const properties = feature.properties ?? {}
          const keys = Object.keys(properties)
          if (keys.some((key) => !['id', 'date', 'year', 'severity'].includes(key)) ||
              !properties.id || !/^20(23|24|25)-\d{2}-\d{2}$/.test(properties.date ?? '') ||
              ![2023, 2024, 2025].includes(properties.year) ||
              !['A1', 'A2'].includes(properties.severity)) {
            throw new Error(`${file} 含無效或非公開白名單的事故欄位`)
          }
        } else if (file.includes('/risks/')) {
          const properties = feature.properties ?? {}
          if (!['flood', 'liquefaction'].includes(properties.riskType) ||
              !['low', 'attention', 'priority'].includes(properties.level) ||
              !properties.officialCategory) {
            throw new Error(`${file} 含無效災害分類`)
          }
        } else if (file.includes('/facilities/')) {
          const properties = feature.properties ?? {}
          if (['address', 'tel', 'phone'].some((key) => key in properties)) {
            throw new Error(`${file} 不得發布地址或電話`)
          }
          if (['parking', 'medical', 'school', 'park', 'library', 'market'].includes(properties.category) &&
              (!properties.id || !properties.name || !properties.facilityType)) {
            throw new Error(`${file} 含無效生活機能欄位`)
          }
          if (properties.category === 'school' &&
              (!Array.isArray(properties.schoolLevels) ||
                !Array.isArray(properties.officialCodes))) {
            throw new Error(`${file} 含無效學校級別或代碼`)
          }
          if (properties.category === 'park' &&
              !['park', 'green-space', 'plaza'].includes(properties.parkType)) {
            throw new Error(`${file} 含無效公園類型`)
          }
          if (properties.category === 'library' && properties.facilityType !== 'public-library') {
            throw new Error(`${file} 含無效圖書館類型`)
          }
          if (properties.category === 'market' &&
              (properties.facilityType !== 'traditional-market' ||
                !['public', 'private'].includes(properties.marketOwnership))) {
            throw new Error(`${file} 含無效傳統零售市場類型`)
          }
        }
      }
    }
  }
  for (const source of Object.values(manifest.sources)) {
    for (const file of source.files ?? []) {
      if (!relativeFiles.has(file)) throw new Error(`${source.id} 引用不存在檔案 ${file}`)
      const fileSize = (await stat(join(directory, file))).size
      if (fileSize > 5 * 1024 * 1024) throw new Error(`${file} 超過 5 MB，必須再切割`)
    }
    const automated = source.qualityGates?.automated
    if (source.qualityGates?.manualAudit && !automated?.datasetSha256) {
      throw new Error(`${source.id} 缺少候選檔 datasetSha256`)
    }
    if (automated?.datasetSha256) {
      const actual = await sourceFilesSha256(directory, source.files)
      if (actual !== automated.datasetSha256) {
        throw new Error(`${source.id} 候選檔雜湊與 manifest 不一致`)
      }
    }
  }
  const expectedDistricts = new Set(ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`))
  if (manifest.coverage.districts.length !== expectedDistricts.size ||
      manifest.coverage.districts.some((district) => !expectedDistricts.has(district))) {
    throw new Error('manifest 必須完整列出雙北 41 區')
  }
  const expectedFiles = {
    'district-boundary': 41,
    flood: 410,
    liquefaction: 41,
    rail: 41,
    parking: 41,
    medical: 41,
    school: 41,
    park: 41,
    library: 41,
    market: 41,
    accidents: 123,
  }
  for (const [id, expected] of Object.entries(expectedFiles)) {
    const source = manifest.sources[id]
    if (source?.files?.length && source.files.length !== expected) {
      throw new Error(`${id} 應有 ${expected} 個檔案，實際為 ${source.files.length}`)
    }
  }
  return { manifest, files: files.length, jsonFiles: jsonFiles.length }
}

export async function sourceFilesSha256(directory, files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    hash.update(file)
    hash.update(await readFile(join(directory, file)))
  }
  return hash.digest('hex')
}

export async function writeHealth(directory, manifest) {
  const health = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(manifest.sources).map(([id, source]) => [id, {
      status: source.status,
      updatedAt: source.updatedAt,
      attemptedAt: source.attemptedAt,
      lastAttempt: source.lastAttempt,
      recordCount: source.recordCount,
      matchingRate: source.matchingRate,
      matchingRates: source.matchingRates,
    }])),
  }
  await writeFile(join(directory, 'health.json'), `${JSON.stringify(health, null, 2)}\n`)
}
