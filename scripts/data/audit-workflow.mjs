import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  evaluatePriceAudit,
  evaluateRiskAudit,
  PRICE_AUDIT_FIELDS,
} from './audit.mjs'

const VALID_RESULTS = new Set(['matched', 'mismatch', 'inconclusive'])
const FORBIDDEN_AUDIT_KEYS = new Set(['address', 'districtLabel'])

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, file)
}

function assertAuditPrivacy(value, path = 'audit') {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_AUDIT_KEYS.has(key)) {
      throw new Error(`${path} 不得保存隱私欄位 ${key}`)
    }
    assertAuditPrivacy(child, `${path}.${key}`)
  }
}

function priceCandidates(candidateFile) {
  return Object.entries(candidateFile.samples).flatMap(([city, groups]) =>
    ['primary', 'reserve'].flatMap((tier) =>
      groups[tier].map((sample) => ({ ...sample, city, tier }))))
}

function riskCandidates(candidateFile) {
  return ['flood', 'liquefaction'].flatMap((source) =>
    Object.entries(candidateFile.samples[source]).flatMap(([city, samples]) =>
      samples.map((sample) => ({ ...sample, source, city }))))
}

function assertAdapterVersion(audit, candidates) {
  if (audit.adapterVersion !== candidates.adapterVersion) {
    throw new Error(
      `adapter 版本不一致：audit ${audit.adapterVersion}、candidate ${candidates.adapterVersion}`,
    )
  }
}

function readiness(audit, manifest) {
  const price = evaluatePriceAudit(
    { ...audit.price, status: 'passed' },
    {
      adapterVersion:
        manifest.sources['actual-price'].qualityGates.automated.adapterVersion,
    },
  )
  const risks = Object.fromEntries(['flood', 'liquefaction'].map((source) => [
    source,
    evaluateRiskAudit(
      { ...audit.risks, status: 'passed' },
      source,
      {
        adapterVersion:
          manifest.sources[source].qualityGates.automated.adapterVersion,
      },
    ),
  ]))
  return {
    price,
    flood: risks.flood,
    liquefaction: risks.liquefaction,
    ready: price.passed && risks.flood.passed && risks.liquefaction.passed,
  }
}

async function loadContext(root) {
  const files = {
    manifest: join(root, 'public', 'data', 'manifest.json'),
    priceAudit: join(root, 'scripts', 'data', 'audits', 'price-v1.json'),
    riskAudit: join(root, 'scripts', 'data', 'audits', 'risks-v1.json'),
    priceCandidates: join(root, '.data-cache', 'price-audit-candidates.json'),
    riskCandidates: join(root, '.data-cache', 'risk-audit-candidates.json'),
  }
  const [manifest, priceAudit, riskAudit, priceCandidateFile, riskCandidateFile] =
    await Promise.all([
      readJson(files.manifest),
      readJson(files.priceAudit),
      readJson(files.riskAudit),
      readJson(files.priceCandidates),
      readJson(files.riskCandidates),
    ])
  assertAdapterVersion(priceAudit, priceCandidateFile)
  assertAdapterVersion(riskAudit, riskCandidateFile)
  assertAuditPrivacy(priceAudit)
  assertAuditPrivacy(riskAudit)
  return {
    files,
    manifest,
    priceAudit,
    riskAudit,
    priceCandidateFile,
    riskCandidateFile,
  }
}

function nextPriceCandidate(candidates, samples, current) {
  const used = new Set(samples.map((sample) => sample.id))
  return candidates.find((candidate) =>
    candidate.tier === 'reserve' &&
    candidate.city === current.city &&
    candidate.buildingType === current.buildingType &&
    !used.has(candidate.id)) ?? null
}

function priceRecord(candidate, { result, attempts, mismatchFields, now }) {
  if (!VALID_RESULTS.has(result)) throw new Error(`不支援的 result：${result}`)
  if (result === 'inconclusive' && attempts < 2) {
    throw new Error('inconclusive 必須至少記錄兩次查詢')
  }
  const record = {
    id: candidate.id,
    city: candidate.city,
    buildingType: candidate.buildingType,
    result,
    checkedAt: now,
    attemptCount: attempts,
  }
  if (result === 'inconclusive') {
    record.reason = '官方查詢逾時或找不到可獨立核對的紀錄；不計入通過樣本'
    return record
  }
  const mismatches = new Set(mismatchFields)
  if (result === 'mismatch' && mismatches.size === 0) {
    throw new Error('mismatch 必須提供 --mismatch-fields')
  }
  for (const field of mismatches) {
    if (!PRICE_AUDIT_FIELDS.includes(field)) throw new Error(`未知價格欄位：${field}`)
  }
  record.fields = Object.fromEntries(
    PRICE_AUDIT_FIELDS.map((field) => [field, !mismatches.has(field)]),
  )
  if (result === 'matched' && mismatches.size > 0) {
    throw new Error('matched 不得提供 mismatch 欄位')
  }
  return record
}

function riskRecord(candidate, { result, observed, attempts, evidence, now }) {
  if (!['matched', 'mismatch'].includes(result)) {
    throw new Error('災害 result 只接受 matched 或 mismatch')
  }
  if (!observed) throw new Error('災害稽核必須提供 --observed')
  if (candidate.boundaryDistanceMeters < 20) {
    throw new Error(`${candidate.id} 距圖層邊界不足 20 公尺`)
  }
  if (result === 'matched' && observed !== candidate.expectedCategory) {
    throw new Error('observed 與 expected 不同時必須記為 mismatch')
  }
  if (result === 'mismatch' && observed === candidate.expectedCategory) {
    throw new Error('observed 與 expected 相同時不得記為 mismatch')
  }
  const verificationMethod = evidence?.verificationMethod ?? 'official-map'
  if (!['official-map', 'official-raw-offline'].includes(verificationMethod)) {
    throw new Error(`未知災害驗證方式：${verificationMethod}`)
  }
  return {
    id: candidate.id,
    source: candidate.source,
    city: candidate.city,
    district: candidate.district,
    longitude: Number(candidate.longitude.toFixed(5)),
    latitude: Number(candidate.latitude.toFixed(5)),
    caseType: candidate.caseType,
    expectedCategory: candidate.expectedCategory,
    observedCategory: observed,
    scenario: candidate.scenario ?? null,
    result,
    verificationMethod,
    ...(evidence ? { evidence } : {}),
    checkedAt: now,
    attemptCount: attempts,
  }
}

export async function recordAudit(root, {
  source,
  id,
  result,
  observed,
  attempts = 1,
  mismatchFields = [],
  evidence = null,
  replace = false,
  now = new Date().toISOString(),
}) {
  const context = await loadContext(root)
  const isPrice = source === 'price'
  if (!isPrice && !['flood', 'liquefaction'].includes(source)) {
    throw new Error(`不支援的 source：${source}`)
  }
  const candidates = isPrice
    ? priceCandidates(context.priceCandidateFile)
    : riskCandidates(context.riskCandidateFile).filter((sample) => sample.source === source)
  const candidate = candidates.find((sample) => sample.id === id)
  if (!candidate) throw new Error(`${source} 候選清單不存在 ID ${id}`)
  const audit = isPrice ? context.priceAudit : context.riskAudit
  const existingIndex = audit.samples.findIndex((sample) => sample.id === id)
  if (existingIndex >= 0 && !replace) {
    throw new Error(`${id} 已有稽核紀錄；確認重做時請加 --replace`)
  }
  const record = isPrice
    ? priceRecord(candidate, { result, attempts, mismatchFields, now })
    : riskRecord(candidate, { result, observed, attempts, evidence, now })
  if (existingIndex >= 0) audit.samples[existingIndex] = record
  else audit.samples.push(record)
  audit.checkedAt = now

  const nextContext = {
    price: isPrice ? audit : context.priceAudit,
    risks: isPrice ? context.riskAudit : audit,
  }
  const progress = readiness(nextContext, context.manifest)
  if (isPrice) audit.status = progress.price.passed ? 'passed' : 'pending'
  else audit.status =
    progress.flood.passed && progress.liquefaction.passed ? 'passed' : 'pending'
  assertAuditPrivacy(audit)
  await writeJsonAtomic(
    isPrice ? context.files.priceAudit : context.files.riskAudit,
    audit,
  )
  return {
    record,
    progress,
    next: isPrice && result === 'inconclusive'
      ? nextPriceCandidate(candidates, audit.samples, candidate)
      : null,
  }
}

export async function auditStatus(root) {
  const context = await loadContext(root)
  const progress = readiness({
    price: context.priceAudit,
    risks: context.riskAudit,
  }, context.manifest)
  const priceSamples = context.priceAudit.samples
  const riskSamples = context.riskAudit.samples
  return {
    ...progress,
    adapterVersions: {
      price: context.priceAudit.adapterVersion,
      risks: context.riskAudit.adapterVersion,
    },
    inconclusive: priceSamples.filter((sample) => sample.result === 'inconclusive').length,
    mismatches: [...priceSamples, ...riskSamples]
      .filter((sample) => sample.result === 'mismatch').length,
    verificationMethods: Object.fromEntries(['flood', 'liquefaction'].map((source) => [
      source,
      [...new Set(riskSamples
        .filter((sample) => sample.source === source && sample.result === 'matched')
        .map((sample) => sample.verificationMethod)
        .filter(Boolean))],
    ])),
  }
}

export { assertAuditPrivacy }
