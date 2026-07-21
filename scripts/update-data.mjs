#!/usr/bin/env node
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  evaluateAccidentAudit,
  evaluateFacilityAudit,
  evaluatePriceAudit,
  evaluateRailAudit,
  evaluateRiskAudit,
  manualGate,
} from './data/audit.mjs'
import { ALL_DISTRICTS } from './data/constants.mjs'
import { sourceFilesSha256, validateData, writeHealth } from './data/manifest.mjs'
import { updateOfficialPrice } from './data/price.mjs'
import { updateOfficialCommunity } from './data/community.mjs'
import { updateOfficialFacilities } from './data/facilities.mjs'
import { updateOfficialLibraries } from './data/library.mjs'
import { updateOfficialRisks } from './data/risks.mjs'
import { updateOfficialTransport } from './data/transport.mjs'
import { updateOfficialAccidents } from './data/accidents.mjs'

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

function sourceFailure(previous, id, now, message) {
  return {
    version: null,
    updatedAt: null,
    recordCount: 0,
    coverage: { cities: [], districts: [] },
    downloadUrl: '',
    sha256: null,
    matchingRate: null,
    excluded: {},
    files: [],
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
    id: result.id ?? previous?.id,
    status: 'official',
    version: result.version,
    updatedAt: result.updatedAt,
    attemptedAt: now,
    recordCount: result.recordCount,
    coverage,
    downloadUrl,
    sha256: result.sha256,
    matchingRate: result.matchingRate ?? null,
    matchingRates: result.matchingRates ?? previous?.matchingRates,
    metadataCheckedAt: result.metadataCheckedAt ?? now,
    validUntil: result.validUntil ?? null,
    qualityGates: result.qualityGates ?? previous?.qualityGates,
    excluded: result.excluded,
    lastAttempt: { status: 'success', message: '下載、schema 與品質檢查通過' },
    files: result.files,
  }
}

async function main() {
  if (validateOnly) {
    const report = await validateData(publicData)
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
        const audit = JSON.parse(await readFile(
          join(root, 'scripts', 'data', 'audits', 'price-v1.json'),
          'utf8',
        ))
        const datasetSha256 = await sourceFilesSha256(staging, result.files)
        const auditEvaluation = evaluatePriceAudit(audit, {
          adapterVersion: result.adapterVersion,
        })
        const auditPassed = auditEvaluation.passed
        const nextPrice = officialSource(
          manifest.sources['actual-price'],
          {
            ...result,
            id: 'actual-price',
            qualityGates: {
              automated: {
                status: 'passed',
                adapterVersion: result.adapterVersion,
                checkedAt: now,
                datasetSha256,
              },
              manualAudit: manualGate(auditEvaluation, result.adapterVersion, audit.checkedAt),
            },
          },
          now,
          'https://data.gov.tw/dataset/25119',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
            years: result.years,
          },
        )
        if (!auditPassed) {
          nextPrice.status = 'unavailable'
          nextPrice.lastAttempt = {
            status: 'success',
            message: '自動品質檢查通過；等待臺北／新北各 10 筆人工複核',
          }
        }
        manifest.sources['actual-price'] = nextPrice
        manifest.coverage.years = result.years
        log('price', `${auditPassed ? '正式' : '候選'}交易 ${result.recordCount.toLocaleString('zh-TW')} 筆，匹配率 ${(result.matchingRate * 100).toFixed(2)}%`)
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
    const results = await updateOfficialTransport({
      output: staging,
      cache,
      now: new Date(),
      dryRun,
      previous: { rail: manifest.sources.rail },
    })
    for (const result of results) {
      const id = result.id
      if (result.status === 'official' && !dryRun) {
        let qualityGates
        let railAudit
        let railEvaluation
        if (id === 'rail') {
          railAudit = JSON.parse(await readFile(
            join(root, 'scripts', 'data', 'audits', 'rail-v1.json'),
            'utf8',
          ))
          const datasetSha256 = await sourceFilesSha256(staging, result.files)
          railEvaluation = evaluateRailAudit(railAudit, {
            adapterVersion: result.adapterVersion,
          })
          qualityGates = {
            automated: {
              status: 'passed',
              adapterVersion: result.adapterVersion,
              checkedAt: now,
              datasetSha256,
            },
            manualAudit: manualGate(railEvaluation, result.adapterVersion, railAudit.checkedAt),
          }
        }
        const nextSource = officialSource(
          manifest.sources[id],
          { ...result, qualityGates },
          now,
          id === 'metro'
            ? 'https://data.taipei/dataset/detail?id=1eefa68d-7c8d-491b-8e75-66a161947426'
            : id === 'bus-new-taipei'
              ? 'https://data.ntpc.gov.tw/datasets/34b402a8-53d9-483d-9406-24a682c2d6dc'
              : 'https://data.gov.tw/dataset/33425',
          {
            cities: id === 'bus-new-taipei' ? ['new-taipei'] : ['taipei', 'new-taipei'],
            districts: result.files.map((file) => file.split('/').slice(0, 2).join('/')),
          },
        )
        if (id === 'rail') {
          const prerequisitesPassed = ['actual-price', 'flood', 'liquefaction']
            .every((source) => manifest.sources[source]?.status === 'official')
          if (!railEvaluation.passed || !prerequisitesPassed) {
            nextSource.status = 'unavailable'
            nextSource.lastAttempt = {
              status: 'success',
              message: !prerequisitesPassed
                ? '臺鐵自動 QA 通過；等待價格與災害來源先完成正式發布'
                : '自動 QA 通過；等待臺北 4 站及新北 5 站人工抽查',
            }
          }
        }
        manifest.sources[id] = nextSource
        log('transport', `${id}：${result.recordCount.toLocaleString('zh-TW')} 筆`)
      } else if (result.status === 'failed') {
        failed = true
        manifest.sources[id] = sourceFailure(manifest.sources[id], id, now, result.error)
      }
    }
  }

  if (shouldRun('risks')) {
    log('risks', '更新行政區界、10 種淹水情境與雙北土壤液化')
    try {
      const result = await updateOfficialRisks({
        output: staging,
        cache,
        now: new Date(),
        dryRun,
        reuseCache: process.env.REUSE_DATA_CACHE === 'true',
        forceRebuild: process.env.FORCE_DATA_REBUILD === 'true',
        previous: {
          boundary: manifest.sources['district-boundary'],
          flood: manifest.sources.flood,
          liquefaction: manifest.sources.liquefaction,
        },
      })
      if (!dryRun) {
        const audit = JSON.parse(await readFile(
          join(root, 'scripts', 'data', 'audits', 'risks-v1.json'),
          'utf8',
        ))
        const datasetHashes = Object.fromEntries(await Promise.all(
          ['district-boundary', 'flood', 'liquefaction'].map(async (source) => {
            const resultKey = source === 'district-boundary' ? 'boundary' : source
            return [source, await sourceFilesSha256(staging, result[resultKey].files)]
          }),
        ))
        const evaluations = Object.fromEntries(await Promise.all(
          ['flood', 'liquefaction'].map(async (source) => [source, evaluateRiskAudit(
            audit,
            source,
            {
              adapterVersion: result.adapterVersion,
            },
          )]),
        ))
        const auditPassed = (source) => evaluations[source].passed
        const qualityGates = (source) => ({
          automated: {
            status: 'passed',
            adapterVersion: result.adapterVersion,
            checkedAt: now,
            gdalVersion: result.gdalVersion,
            datasetSha256: datasetHashes[source],
          },
          manualAudit: manualGate(evaluations[source], result.adapterVersion, audit.checkedAt),
        })
        manifest.sources['district-boundary'] = officialSource(
          manifest.sources['district-boundary'],
          {
            ...result.boundary,
            qualityGates: {
              automated: {
                status: 'passed',
                adapterVersion: result.adapterVersion,
                checkedAt: now,
                gdalVersion: result.gdalVersion,
                datasetSha256: datasetHashes['district-boundary'],
              },
            },
          },
          now,
          'https://data.gov.tw/dataset/7441',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
          },
        )
        manifest.sources.flood = officialSource(
          manifest.sources.flood,
          {
            ...result.flood,
            qualityGates: qualityGates('flood'),
          },
          now,
          'https://data.gov.tw/dataset/25766',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
          },
        )
        manifest.sources.liquefaction = officialSource(
          manifest.sources.liquefaction,
          {
            ...result.liquefaction,
            qualityGates: qualityGates('liquefaction'),
          },
          now,
          'https://data.gov.tw/dataset/28691',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
          },
        )
        for (const id of ['flood', 'liquefaction']) {
          if (!auditPassed(id)) {
            manifest.sources[id].status = 'unavailable'
            manifest.sources[id].lastAttempt = {
              status: 'success',
              message: '自動資料品質檢查通過；等待臺北／新北各 5 個位置的官方圖台人工抽查',
            }
          }
        }
      }
      log(
        'risks',
        result.unchanged
          ? '官方檔案雜湊未變，略過圖層重建'
          : `淹水 ${result.flood.recordCount.toLocaleString('zh-TW')} 筆；液化 ${result.liquefaction.recordCount.toLocaleString('zh-TW')} 筆`,
      )
    } catch (error) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      log('risks', `失敗：${message}`)
      for (const id of ['district-boundary', 'flood', 'liquefaction']) {
        manifest.sources[id] = sourceFailure(manifest.sources[id], id, now, message)
      }
    }
  }
  if (shouldRun('facilities')) {
    log('facilities', '更新雙北路外停車場、醫院、學校、公園綠地與公共圖書館')
    const update = await updateOfficialFacilities({
      output: staging,
      cache,
      now: new Date(),
      dryRun,
      reuseCache: process.env.REUSE_DATA_CACHE === 'true',
      previous: {
        parking: manifest.sources.parking,
        medical: manifest.sources.medical,
      },
    })
    if (!dryRun) {
      const audit = JSON.parse(await readFile(
        join(root, 'scripts', 'data', 'audits', 'facilities-v1.json'),
        'utf8',
      ))
      for (const result of update.results) {
        const id = result.id
        if (result.status === 'failed') {
          failed = true
          const nextSource = sourceFailure(
            manifest.sources[id],
            id,
            now,
            result.error,
          )
          if (result.error.includes('門牌匹配率') || result.error.includes('未達 95%')) {
            nextSource.status = 'unavailable'
            nextSource.lastAttempt.message = `自動 QA 未達發布門檻：${result.error}`
          }
          manifest.sources[id] = nextSource
          log('facilities', `${id} 失敗：${result.error}`)
          continue
        }
        const datasetSha256 = await sourceFilesSha256(staging, result.files)
        const evaluation = evaluateFacilityAudit(audit, id, {
          adapterVersion: result.adapterVersion,
        })
        const nextSource = officialSource(
          manifest.sources[id],
          {
            ...result,
            ...(id === 'medical' ? { matchingRate: update.matchingRate } : {}),
            qualityGates: {
              automated: {
                status: 'passed',
                adapterVersion: result.adapterVersion,
                checkedAt: now,
                datasetSha256,
              },
              manualAudit: manualGate(
                evaluation,
                result.adapterVersion,
                audit.checkedAt,
              ),
            },
          },
          now,
          id === 'parking'
            ? 'https://data.taipei/dataset/detail?id=d5c0656b-5250-4179-a491-c94daa56ef2c'
            : 'https://data.taipei/dataset/detail?id=b02cd6b2-79be-4d7f-ae78-305b2af668f5',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
          },
        )
        if (!evaluation.passed) {
          nextSource.status = 'unavailable'
          nextSource.lastAttempt = {
            status: 'success',
            message: '自動 QA 通過；等待臺北／新北各 5 筆官方原始檔離線驗收',
          }
        }
        manifest.sources[id] = nextSource
        log(
          'facilities',
          `${id}：${result.recordCount.toLocaleString('zh-TW')} 筆` +
          `${evaluation.passed ? '，正式' : '，候選'}`,
        )
      }
    } else {
      for (const result of update.results) {
        if (result.status === 'failed') failed = true
        log(
          'facilities',
          result.status === 'failed'
            ? `${result.id} dry run 失敗：${result.error}`
            : `${result.id} dry run：${result.recordCount.toLocaleString('zh-TW')} 筆`,
        )
      }
    }
    const community = await updateOfficialCommunity({
      output: staging,
      cache,
      now: new Date(),
      dryRun,
      reuseCache: process.env.REUSE_DATA_CACHE === 'true',
      previous: {
        school: manifest.sources.school,
        park: manifest.sources.park,
      },
    })
    if (!dryRun) {
      const audit = JSON.parse(await readFile(
        join(root, 'scripts', 'data', 'audits', 'community-v2.json'),
        'utf8',
      ))
      for (const result of community.results) {
        const id = result.id
        if (result.status === 'failed') {
          failed = true
          const nextSource = sourceFailure(
            manifest.sources[id],
            id,
            now,
            result.error,
          )
          if (result.error.includes('門牌匹配率') || result.error.includes('未達 95%')) {
            nextSource.status = 'unavailable'
            nextSource.lastAttempt.message = `自動 QA 未達發布門檻：${result.error}`
          }
          manifest.sources[id] = nextSource
          log('facilities', `${id} 失敗：${result.error}`)
          continue
        }
        const datasetSha256 = await sourceFilesSha256(staging, result.files)
        const evaluation = evaluateFacilityAudit({ ...audit, status: 'passed' }, id, {
          adapterVersion: result.adapterVersion,
        })
        const nextSource = officialSource(
          manifest.sources[id],
          {
            ...result,
            qualityGates: {
              automated: {
                status: 'passed',
                adapterVersion: result.adapterVersion,
                checkedAt: now,
                datasetSha256,
              },
              manualAudit: manualGate(
                evaluation,
                result.adapterVersion,
                audit.checkedAt,
              ),
            },
          },
          now,
          id === 'school'
            ? 'https://data.gov.tw/dataset/6087'
            : 'https://data.taipei/dataset/detail?id=ea732fb5-4bec-4be7-93f2-8ab91e74a6c6',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
          },
        )
        if (!evaluation.passed) {
          nextSource.status = 'unavailable'
          nextSource.lastAttempt = {
            status: 'success',
            message: '自動 QA 通過；等待臺北／新北各 5 筆官方原始檔離線驗收',
          }
        }
        manifest.sources[id] = nextSource
        log(
          'facilities',
          `${id}：${result.recordCount.toLocaleString('zh-TW')} 筆` +
          `${evaluation.passed ? '，正式' : '，候選'}`,
        )
      }
    } else {
      for (const result of community.results) {
        if (result.status === 'failed') failed = true
        log(
          'facilities',
          result.status === 'failed'
            ? `${result.id} dry run 失敗：${result.error}`
            : `${result.id} dry run：${result.recordCount.toLocaleString('zh-TW')} 筆`,
        )
      }
    }
    try {
      const library = await updateOfficialLibraries({
        output: staging,
        cache,
        now: new Date(),
        dryRun,
        reuseCache: process.env.REUSE_DATA_CACHE === 'true',
        previous: manifest.sources.library,
      })
      if (dryRun) {
        log('facilities', `library dry run：${library.recordCount.toLocaleString('zh-TW')} 筆`)
      } else {
        const [audit, candidates] = await Promise.all([
          readFile(
            join(root, 'scripts', 'data', 'audits', 'library-v1.json'),
            'utf8',
          ).then(JSON.parse),
          readFile(join(cache, 'library-audit-candidates.json'), 'utf8').then(JSON.parse),
        ])
        const datasetSha256 = await sourceFilesSha256(staging, library.files)
        const evaluation = evaluateFacilityAudit(audit, 'library', {
          adapterVersion: library.adapterVersion,
        })
        const nextSource = officialSource(
          manifest.sources.library,
          {
            ...library,
            qualityGates: {
              automated: {
                status: 'passed',
                adapterVersion: library.adapterVersion,
                checkedAt: now,
                datasetSha256,
              },
              manualAudit: manualGate(evaluation, library.adapterVersion, audit.checkedAt),
            },
          },
          now,
          'https://data.gov.tw/dataset/99567',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
          },
        )
        if (candidates.fingerprints.sourceSha256 !== library.sha256 ||
            candidates.fingerprints.datasetSha256 !== datasetSha256) {
          throw new Error('library 候選 fingerprints 與輸出不一致')
        }
        if (!evaluation.passed) {
          nextSource.status = 'unavailable'
          nextSource.lastAttempt = {
            status: 'success',
            message: '自動 QA 通過；等待臺北／新北各 5 筆官方原始檔離線驗收',
          }
        }
        manifest.sources.library = nextSource
        log('facilities', `library：${library.recordCount.toLocaleString('zh-TW')} 筆${evaluation.passed ? '，正式' : '，候選'}`)
      }
    } catch (error) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      manifest.sources.library = sourceFailure(manifest.sources.library, 'library', now, message)
      log('facilities', `library 失敗：${message}`)
    }
  }
  if (shouldRun('accidents')) {
    log('accidents', '更新 2023–2025 雙北 A1／A2 傷亡道路交通事故')
    try {
      const result = await updateOfficialAccidents({
        output: staging,
        cache,
        now: new Date(),
        dryRun,
        reuseCache: process.env.REUSE_DATA_CACHE === 'true',
        previous: manifest.sources.accidents,
      })
      if (dryRun) {
        log('accidents', `dry run：${result.recordCount.toLocaleString('zh-TW')} 件`)
      } else {
        const audit = JSON.parse(await readFile(
          join(root, 'scripts', 'data', 'audits', 'accidents-v1.json'),
          'utf8',
        ))
        const datasetSha256 = await sourceFilesSha256(staging, result.files)
        const evaluation = evaluateAccidentAudit(audit, {
          adapterVersion: result.adapterVersion,
        })
        const nextSource = officialSource(
          manifest.sources.accidents,
          {
            ...result,
            qualityGates: {
              automated: {
                status: 'passed',
                adapterVersion: result.adapterVersion,
                checkedAt: now,
                datasetSha256,
              },
              manualAudit: manualGate(evaluation, result.adapterVersion, audit.checkedAt),
            },
          },
          now,
          'https://data.gov.tw/dataset/177136',
          {
            cities: ['taipei', 'new-taipei'],
            districts: ALL_DISTRICTS.map(({ city, slug }) => `${city}/${slug}`),
            years: result.years,
          },
        )
        if (!evaluation.passed) {
          nextSource.status = 'unavailable'
          nextSource.lastAttempt = {
            status: 'success',
            message: '自動 QA 通過；等待臺北／新北各 5 件官方原始檔離線驗收',
          }
        }
        manifest.sources.accidents = nextSource
        log('accidents', result.unchanged
          ? '官方檔案雜湊未變，略過事故快照重建'
          : `${result.recordCount.toLocaleString('zh-TW')} 件${evaluation.passed ? '，正式' : '，候選'}`)
      }
    } catch (error) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      manifest.sources.accidents = sourceFailure(
        manifest.sources.accidents,
        'accidents',
        now,
        message,
      )
      log('accidents', `失敗：${message}`)
    }
  }

  if (dryRun) {
    log('dry-run', failed ? '驗證完成但有來源失敗，未修改 public/data' : '驗證完成，未修改 public/data')
    await rm(staging, { recursive: true, force: true })
    return
  }

  manifest.generatedAt = now
  manifest.dataVersion = `production-${now.slice(0, 10)}`
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeHealth(staging, manifest)
  const report = await validateData(staging)
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
