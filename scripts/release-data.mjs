#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  evaluateAccidentAudit,
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
const validSources = new Set(['all', 'price', 'risks', 'facilities', 'market', 'accidents'])

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
  let marketRelease = null

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
    const [communityAudit, communityCandidates] = await Promise.all([
      readFile(
        join(root, 'scripts', 'data', 'audits', 'community-v2.json'),
        'utf8',
      ).then(JSON.parse),
      readFile(
        join(root, '.data-cache', 'community-audit-candidates.json'),
        'utf8',
      ).then(JSON.parse),
    ])
    for (const id of ['school', 'park']) {
      try {
        const source = manifest.sources[id]
        await verifyCandidate(source)
        const evaluation = evaluateFacilityAudit({ ...communityAudit, status: 'passed' }, id, {
          adapterVersion: source.qualityGates.automated.adapterVersion,
          sourceSha256: source.sha256,
          addressIndexSha256:
            id === 'park'
              ? communityCandidates.addressIndexSha256['new-taipei']
              : communityCandidates.addressIndexSha256,
          landmarkSha256: communityCandidates.landmarkSha256,
          requireEvidenceSourceSha: true,
        })
        if (id === 'school') {
          const cityHashes = communityCandidates.addressIndexSha256
          const samples = communityAudit.samples.filter((sample) => sample.source === id)
          const hashesValid = samples.every((sample) =>
            sample.evidence?.addressIndexSha256 === cityHashes[sample.city])
          if (!hashesValid) throw new Error('school 門牌索引雜湊與候選不一致')
        }
        promoteSource(source, evaluation, communityAudit, now)
        promoted += 1
      } catch (error) {
        failures.push(`${id}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const [libraryAudit, libraryCandidates] = await Promise.all([
        readFile(
          join(root, 'scripts', 'data', 'audits', 'library-v1.json'),
          'utf8',
        ).then(JSON.parse),
        readFile(
          join(root, '.data-cache', 'library-audit-candidates.json'),
          'utf8',
        ).then(JSON.parse),
      ])
      const source = manifest.sources.library
      await verifyCandidate(source)
      if (libraryCandidates.fingerprints.sourceSha256 !== source.sha256 ||
          libraryCandidates.fingerprints.datasetSha256 !== source.qualityGates.automated.datasetSha256) {
        throw new Error('library 候選 fingerprints 與 manifest 不一致')
      }
      const evaluation = evaluateFacilityAudit(libraryAudit, 'library', {
        adapterVersion: source.qualityGates.automated.adapterVersion,
        sourceSha256: source.sha256,
        requireEvidenceSourceSha: true,
      })
      promoteSource(source, evaluation, libraryAudit, now)
      promoted += 1
    } catch (error) {
      failures.push(`library：${error instanceof Error ? error.message : String(error)}`)
    }
    failures.forEach((message) => console.error(`[release] 未提升 ${message}`))
    if (promoted === 0) throw new Error('五類設施皆未通過發布閘門')
  }

  if (selectedSource === 'all' || selectedSource === 'market') {
    const [audit, candidates] = await Promise.all([
      readFile(join(root, 'scripts', 'data', 'audits', 'market-v1.json'), 'utf8').then(JSON.parse),
      readFile(join(root, '.data-cache', 'market-audit-candidates.json'), 'utf8').then(JSON.parse),
    ])
    if (candidates.status !== 'ready' ||
        candidates.adapterVersion !== candidates.releaseSource?.adapterVersion) {
      throw new Error('market 候選尚未通過自動品質閘門')
    }
    const generated = join(root, '.data-cache', 'generated-market')
    const datasetSha256 = await sourceFilesSha256(
      generated,
      candidates.releaseSource.files,
    )
    if (candidates.fingerprints.sourceSha256 !== candidates.releaseSource.sha256 ||
        candidates.fingerprints.datasetSha256 !== datasetSha256) {
      throw new Error('market 候選 fingerprints 與 cache 輸出不一致')
    }
    const evaluation = evaluateFacilityAudit(audit, 'market', {
      adapterVersion: candidates.adapterVersion,
      sourceSha256: candidates.fingerprints.sourceSha256,
      addressIndexSha256: candidates.addressIndexSha256,
      requireEvidenceSourceSha: true,
    })
    const source = {
      ...manifest.sources.market,
      ...candidates.releaseSource,
      status: 'unavailable',
      attemptedAt: now,
      coverage: {
        cities: ['taipei', 'new-taipei'],
        districts: manifest.coverage.districts,
      },
      downloadUrl: 'https://data.gov.tw/dataset/121593',
      metadataCheckedAt: candidates.generatedAt,
      qualityGates: {
        automated: {
          status: 'passed',
          adapterVersion: candidates.adapterVersion,
          checkedAt: candidates.generatedAt,
          datasetSha256,
        },
      },
      lastAttempt: {
        status: 'success',
        message: '自動 QA 通過；等待臺北／新北各 5 筆官方原始檔離線驗收',
      },
    }
    promoteSource(source, evaluation, audit, now)
    manifest.sources.market = source
    marketRelease = {
      generated,
      files: candidates.releaseSource.files,
    }
  }

  if (selectedSource === 'all' || selectedSource === 'accidents') {
    const [audit, candidates] = await Promise.all([
      readFile(join(root, 'scripts', 'data', 'audits', 'accidents-v1.json'), 'utf8').then(JSON.parse),
      readFile(join(root, '.data-cache', 'accident-audit-candidates.json'), 'utf8').then(JSON.parse),
    ])
    const source = manifest.sources.accidents
    await verifyCandidate(source)
    const evaluation = evaluateAccidentAudit(audit, {
      adapterVersion: source.qualityGates.automated.adapterVersion,
      sourceSha256: source.sha256,
      requireEvidenceSourceSha: true,
    })
    if (candidates.fingerprints.sourceSha256 !== source.sha256 ||
        candidates.fingerprints.datasetSha256 !== source.qualityGates.automated.datasetSha256) {
      throw new Error('accidents 候選 fingerprints 與 manifest 不一致')
    }
    promoteSource(source, evaluation, audit, now)
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
  if (marketRelease) {
    for (const file of marketRelease.files) {
      await mkdir(dirname(join(staging, file)), { recursive: true })
      await cp(join(marketRelease.generated, file), join(staging, file))
    }
  }
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
