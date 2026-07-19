#!/usr/bin/env node
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ALL_DISTRICTS } from './data/constants.mjs'
import { updateOfficialPrice } from './data/price.mjs'
import { updateOfficialTransport } from './data/transport.mjs'

const root = resolve(import.meta.dirname, '..')
const publicData = join(root, 'public', 'data')
const staging = join(root, '.data-staging')
const backup = join(root, '.data-last-good')
const cache = join(root, '.data-cache')
const validSources = new Set(['all', 'price', 'risks', 'transport', 'facilities', 'accidents'])

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return process.argv.includes(`--${name}`) ? 'true' : fallback
}

const selectedSource = option('source', process.env.DATA_SOURCE ?? 'all')
const dryRun = option('dry-run', process.env.DRY_RUN ?? 'false') === 'true'
const validateOnly = process.argv.includes('--validate-only')
if (!validSources.has(selectedSource)) throw new Error(`不支援的 source：${selectedSource}`)

const log = (stage, message) => console.log(`[${stage}] ${message}`)
const shouldRun = (...sources) => selectedSource === 'all' || sources.includes(selectedSource)

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
  if (!Array.isArray(coordinates)) return false
  if (coordinates.length >= 2 && coordinates.every(Number.isFinite)) {
    const [longitude, latitude] = coordinates
    return longitude >= 121.28 && longitude <= 122.02 && latitude >= 24.65 && latitude <= 25.32
  }
  return coordinates.every(validateCoordinates)
}

async function validate(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== '2.0.0' || manifest.mode !== 'production') {
    throw new Error('manifest 必須是 production schema v2')
  }
  const files = await walk(directory)
  const relativeFiles = new Set(files.map((file) => file.slice(directory.length + 1)))
  const jsonFiles = files.filter((file) => file.endsWith('.json') || file.endsWith('.geojson'))
  for (const file of jsonFiles) {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (file.endsWith('.geojson')) {
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        throw new Error(`${file} 不是 FeatureCollection`)
      }
      for (const feature of data.features) {
        if (!feature.geometry || !validateCoordinates(feature.geometry.coordinates)) {
          throw new Error(`${file} 含空 geometry 或雙北範圍外座標`)
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
  }
  const expectedDistricts = new Set(ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`))
  if (manifest.coverage.districts.length !== expectedDistricts.size ||
      manifest.coverage.districts.some((district) => !expectedDistricts.has(district))) {
    throw new Error('manifest 必須完整列出雙北 41 區')
  }
  return { manifest, files: files.length, jsonFiles: jsonFiles.length }
}

function sourceFailure(previous, id, now, message) {
  return {
    ...previous,
    id,
    status: 'failed',
    attemptedAt: now,
    lastAttempt: { status: 'failed', message },
  }
}

function officialSource(previous, result, now, downloadUrl, coverage) {
  return {
    ...previous,
    id: result.id ?? previous.id,
    status: 'official',
    version: result.version,
    updatedAt: result.updatedAt,
    attemptedAt: now,
    recordCount: result.recordCount,
    coverage,
    downloadUrl,
    sha256: result.sha256,
    matchingRate: result.matchingRate ?? null,
    excluded: result.excluded,
    lastAttempt: { status: 'success', message: '下載、schema 與品質檢查通過' },
    files: result.files,
  }
}

async function writeHealth(directory, manifest) {
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
    }])),
  }
  await writeFile(join(directory, 'health.json'), `${JSON.stringify(health, null, 2)}\n`)
}

async function main() {
  if (validateOnly) {
    const report = await validate(publicData)
    log('validate', `${report.jsonFiles} 個 JSON/GeoJSON、${report.files} 個檔案通過驗證`)
    return
  }
  await mkdir(cache, { recursive: true })
  await rm(staging, { recursive: true, force: true })
  await cp(publicData, staging, { recursive: true })
  const manifestPath = join(staging, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const now = new Date().toISOString()
  let failed = false

  if (shouldRun('price')) {
    log('price', '下載最近五年實價登錄與雙北門牌索引')
    try {
      const result = await updateOfficialPrice({
        output: staging,
        cache,
        now: new Date(),
        dryRun,
        reuseCache: process.env.REUSE_DATA_CACHE === 'true',
      })
      if (result.status === 'official') {
        manifest.sources['actual-price'] = officialSource(
          manifest.sources['actual-price'],
          { ...result, id: 'actual-price' },
          now,
          'https://data.gov.tw/dataset/25119',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
            years: result.years,
          },
        )
        manifest.coverage.years = result.years
        log('price', `正式交易 ${result.recordCount.toLocaleString('zh-TW')} 筆，匹配率 ${(result.matchingRate * 100).toFixed(2)}%`)
      } else if (result.status === 'dry-run') {
        log('price', `dry run：匹配率 ${(result.report.matchingRate * 100).toFixed(2)}%，未發布`)
      } else {
        failed = true
        manifest.sources['actual-price'] = sourceFailure(
          manifest.sources['actual-price'],
          'actual-price',
          now,
          `品質門檻未通過：整體匹配率 ${(result.report.matchingRate * 100).toFixed(2)}%；未達門檻行政區 ${result.report.failedDistricts.length}`,
        )
      }
    } catch (error) {
      failed = true
      manifest.sources['actual-price'] = sourceFailure(
        manifest.sources['actual-price'],
        'actual-price',
        now,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  if (shouldRun('transport')) {
    log('transport', '更新臺北捷運與新北公車站位')
    const results = await updateOfficialTransport({ output: staging, cache, now: new Date(), dryRun })
    for (const [index, result] of results.entries()) {
      const id = index === 0 ? 'metro' : 'bus-new-taipei'
      if (result.status === 'official' && !dryRun) {
        manifest.sources[id] = officialSource(
          manifest.sources[id],
          result,
          now,
          id === 'metro'
            ? 'https://data.taipei/dataset/detail?id=1eefa68d-7c8d-491b-8e75-66a161947426'
            : 'https://data.ntpc.gov.tw/datasets/34b402a8-53d9-483d-9406-24a682c2d6dc',
          {
            cities: id === 'metro' ? ['taipei', 'new-taipei'] : ['new-taipei'],
            districts: result.files.map((file) => file.split('/').slice(0, 2).join('/')),
          },
        )
        log('transport', `${id}：${result.recordCount.toLocaleString('zh-TW')} 筆`)
      } else if (result.status === 'failed') {
        failed = true
        manifest.sources[id] = sourceFailure(manifest.sources[id], id, now, result.error)
      }
    }
  }

  if (shouldRun('risks')) log('risks', '官方圖資需先通過 CRS 與 topology 門檻；未接入來源維持 unavailable')
  if (shouldRun('facilities')) log('facilities', '各類設施來源維持獨立 unavailable，避免以單一類別代表全部')
  if (shouldRun('accidents')) log('accidents', '事故來源尚未產生通過去識別與三年度門檻的快照')

  if (dryRun) {
    log('dry-run', failed ? '驗證完成但有來源失敗，未修改 public/data' : '驗證完成，未修改 public/data')
    await rm(staging, { recursive: true, force: true })
    return
  }

  manifest.generatedAt = now
  manifest.dataVersion = `production-${now.slice(0, 10)}`
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeHealth(staging, manifest)
  const report = await validate(staging)
  log('validate', `${report.jsonFiles} 個 JSON/GeoJSON、${report.files} 個檔案通過驗證`)

  await rm(backup, { recursive: true, force: true })
  await rename(publicData, backup)
  try {
    await rename(staging, publicData)
    await rm(backup, { recursive: true, force: true })
    log('publish', failed ? '保留 last-good 並發布來源失敗狀態' : '已原子替換 public/data')
  } catch (error) {
    await access(backup)
    await rename(backup, publicData)
    throw error
  }
}

await main().catch(async (error) => {
  await rm(staging, { recursive: true, force: true })
  console.error(`[pipeline] FAILED: ${error instanceof Error ? error.stack : error}`)
  process.exitCode = 1
})
