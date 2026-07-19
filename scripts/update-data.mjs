#!/usr/bin/env node
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { evaluatePriceAudit, evaluateRailAudit, evaluateRiskAudit, manualGate } from './data/audit.mjs'
import { ALL_DISTRICTS } from './data/constants.mjs'
import { sourceFilesSha256, validateData, writeHealth } from './data/manifest.mjs'
import { updateOfficialPrice } from './data/price.mjs'
import { updateOfficialRisks } from './data/risks.mjs'
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
        const auditEvaluation = evaluatePriceAudit(audit, {
          adapterVersion: result.adapterVersion,
          sourceSha256: result.sha256,
          datasetSha256: await sourceFilesSha256(staging, result.files),
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
          railEvaluation = evaluateRailAudit(railAudit, {
            adapterVersion: result.adapterVersion,
            sourceSha256: result.sha256,
            datasetSha256: await sourceFilesSha256(staging, result.files),
          })
          qualityGates = {
            automated: {
              status: 'passed',
              adapterVersion: result.adapterVersion,
              checkedAt: now,
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
        const evaluations = Object.fromEntries(await Promise.all(
          ['flood', 'liquefaction'].map(async (source) => [source, evaluateRiskAudit(
            audit,
            source,
            {
              adapterVersion: result.adapterVersion,
              sourceSha256: result[source].sha256,
              datasetSha256: await sourceFilesSha256(staging, result[source].files),
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
