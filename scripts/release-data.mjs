#!/usr/bin/env node
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  evaluateFacilityAudit,
  evaluatePriceAudit,
  evaluateRailAudit,
  evaluateRiskAudit,
} from './data/audit.mjs'
import { sourceFilesSha256, validateData, writeHealth } from './data/manifest.mjs'
import { atomicReplace, promoteSource } from './data/release.mjs'

const root = resolve(import.meta.dirname, '..')
const publicData = join(root, 'public', 'data')
const staging = join(root, '.data-release-staging')
const backup = join(root, '.data-release-last-good')
const validSources = new Set(['all', 'price', 'risks', 'facilities'])

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return process.argv.includes(`--${name}`) ? 'true' : fallback
}

const selectedSource = option('source', 'all')
const dryRun = option('dry-run', 'false') === 'true'
if (!validSources.has(selectedSource)) throw new Error(`不支援的 source：${selectedSource}`)

async function verifyCandidate(source) {
  if (!/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) {
    throw new Error(`${source.id} 缺少有效來源雜湊`)
  }
  const expected = source.qualityGates?.automated?.datasetSha256
  const actual = await sourceFilesSha256(publicData, source.files)
  if (!expected || expected !== actual) {
    throw new Error(`${source.id} 候選檔雜湊與 manifest 不一致`)
  }
}

async function main() {
  await validateData(publicData)
  const manifest = JSON.parse(await readFile(join(publicData, 'manifest.json'), 'utf8'))
  const now = new Date().toISOString()

  if (selectedSource === 'all' || selectedSource === 'price') {
    const source = manifest.sources['actual-price']
    const audit = JSON.parse(await readFile(
      join(root, 'scripts', 'data', 'audits', 'price-v1.json'),
      'utf8',
    ))
    await verifyCandidate(source)
    const evaluation = evaluatePriceAudit(audit, {
      adapterVersion: source.qualityGates.automated.adapterVersion,
    })
    promoteSource(source, evaluation, audit, now)
  }

  if (selectedSource === 'all' || selectedSource === 'risks') {
    const audit = JSON.parse(await readFile(
      join(root, 'scripts', 'data', 'audits', 'risks-v1.json'),
      'utf8',
    ))
    for (const id of ['flood', 'liquefaction']) {
      const source = manifest.sources[id]
      await verifyCandidate(source)
      const evaluation = evaluateRiskAudit(audit, id, {
        adapterVersion: source.qualityGates.automated.adapterVersion,
        sourceSha256: source.sha256,
        requireEvidenceSourceSha: true,
      })
      promoteSource(source, evaluation, audit, now)
    }
  }

  if (selectedSource === 'all' || selectedSource === 'facilities') {
    const [audit, candidates] = await Promise.all([
      readFile(
        join(root, 'scripts', 'data', 'audits', 'facilities-v1.json'),
        'utf8',
      ).then(JSON.parse),
      readFile(
        join(root, '.data-cache', 'facility-audit-candidates.json'),
        'utf8',
      ).then(JSON.parse),
    ])
    const failures = []
    let promoted = 0
    for (const id of ['parking', 'medical']) {
      try {
        const source = manifest.sources[id]
        await verifyCandidate(source)
        const evaluation = evaluateFacilityAudit(audit, id, {
          adapterVersion: source.qualityGates.automated.adapterVersion,
          sourceSha256: source.sha256,
          addressIndexSha256: candidates.addressIndexSha256,
          requireEvidenceSourceSha: true,
        })
        promoteSource(source, evaluation, audit, now)
        promoted += 1
      } catch (error) {
        failures.push(`${id}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    failures.forEach((message) => console.error(`[release] 未提升 ${message}`))
    if (promoted === 0) throw new Error('停車場與醫院皆未通過發布閘門')
  }

  const railPrerequisites = ['actual-price', 'flood', 'liquefaction']
    .every((id) => manifest.sources[id]?.status === 'official')
  const rail = manifest.sources.rail
  if (railPrerequisites && rail?.status !== 'official') {
    const audit = JSON.parse(await readFile(
      join(root, 'scripts', 'data', 'audits', 'rail-v1.json'),
      'utf8',
    ))
    await verifyCandidate(rail)
    const evaluation = evaluateRailAudit(audit, {
      adapterVersion: rail.qualityGates.automated.adapterVersion,
    })
    if (evaluation.passed) promoteSource(rail, evaluation, audit, now)
  }

  if (dryRun) {
    console.log(`[release] dry run 通過：${selectedSource} 可正式發布`)
    return
  }

  await rm(staging, { recursive: true, force: true })
  await cp(publicData, staging, { recursive: true })
  manifest.generatedAt = now
  manifest.dataVersion = `production-${now.slice(0, 10)}`
  await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeHealth(staging, manifest)
  await validateData(staging)

  await atomicReplace(publicData, staging, backup)
  console.log(`[release] 已原子發布：${selectedSource}`)
}

main().catch(async (error) => {
  await rm(staging, { recursive: true, force: true })
  console.error(`[release] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
