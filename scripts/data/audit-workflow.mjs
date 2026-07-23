import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  evaluateAccidentAudit,
  evaluateFacilityAudit,
  evaluatePriceAudit,
  evaluateRiskAudit,
  PRICE_AUDIT_FIELDS,
} from './audit.mjs'

const VALID_RESULTS = new Set(['matched', 'mismatch', 'inconclusive'])
const FORBIDDEN_AUDIT_KEYS = new Set([
  'address', 'districtLabel', 'location', 'police', 'time', 'party',
])

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

function facilityCandidates(candidateFile) {
  return Object.keys(candidateFile.samples).flatMap((source) =>
    Object.entries(candidateFile.samples[source]).flatMap(([city, samples]) =>
      samples.map((sample) => ({ ...sample, source, city }))))
}

function accidentCandidates(candidateFile) {
  return Object.entries(candidateFile.samples).flatMap(([city, samples]) =>
    samples.map((sample) => ({ ...sample, source: 'accidents', city })))
}

function libraryCandidates(candidateFile) {
  return Object.entries(candidateFile.samples).flatMap(([city, samples]) =>
    samples.map((sample) => ({ ...sample, source: 'library', city })))
}

function marketCandidates(candidateFile) {
  return Object.entries(candidateFile.samples ?? {}).flatMap(([city, samples]) =>
    samples.map((sample) => ({ ...sample, source: 'market', city })))
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
  const facilities = Object.fromEntries(['parking', 'medical'].map((source) => [
    source,
    evaluateFacilityAudit(
      { ...audit.facilities, status: 'passed' },
      source,
      {
        adapterVersion:
          manifest.sources[source].qualityGates.automated.adapterVersion,
      },
    ),
  ]))
  const community = Object.fromEntries(['school', 'park'].map((source) => [
    source,
    evaluateFacilityAudit(
      { ...audit.community, status: 'passed' },
      source,
      {
        adapterVersion:
          manifest.sources[source]?.qualityGates?.automated?.adapterVersion ??
          audit.community.adapterVersion,
      },
    ),
  ]))
  const library = evaluateFacilityAudit(
    { ...audit.library, status: 'passed' },
    'library',
    {
      adapterVersion:
        manifest.sources.library?.qualityGates?.automated?.adapterVersion ??
        audit.library.adapterVersion,
    },
  )
  const accidents = evaluateAccidentAudit(
    { ...audit.accidents, status: 'passed' },
    {
      adapterVersion: manifest.sources.accidents?.qualityGates?.automated?.adapterVersion ??
        audit.accidents.adapterVersion,
    },
  )
  const market = evaluateFacilityAudit(
    { ...audit.market, status: 'passed' },
    'market',
    {
      adapterVersion:
        manifest.sources.market?.qualityGates?.automated?.adapterVersion ??
        audit.market.adapterVersion,
    },
  )
  return {
    price,
    flood: risks.flood,
    liquefaction: risks.liquefaction,
    parking: facilities.parking,
    medical: facilities.medical,
    school: community.school,
    park: community.park,
    library,
    accidents,
    market,
    ready: price.passed && risks.flood.passed && risks.liquefaction.passed &&
      facilities.parking.passed && facilities.medical.passed &&
      community.school.passed && community.park.passed && library.passed &&
      market.passed && accidents.passed,
  }
}

async function loadContext(root) {
  const files = {
    manifest: join(root, 'public', 'data', 'manifest.json'),
    priceAudit: join(root, 'scripts', 'data', 'audits', 'price-v1.json'),
    riskAudit: join(root, 'scripts', 'data', 'audits', 'risks-v1.json'),
    facilityAudit: join(root, 'scripts', 'data', 'audits', 'facilities-v1.json'),
    communityAudit: join(root, 'scripts', 'data', 'audits', 'community-v2.json'),
    libraryAudit: join(root, 'scripts', 'data', 'audits', 'library-v1.json'),
    accidentAudit: join(root, 'scripts', 'data', 'audits', 'accidents-v1.json'),
    marketAudit: join(root, 'scripts', 'data', 'audits', 'market-v1.json'),
    priceCandidates: join(root, '.data-cache', 'price-audit-candidates.json'),
    riskCandidates: join(root, '.data-cache', 'risk-audit-candidates.json'),
    facilityCandidates: join(root, '.data-cache', 'facility-audit-candidates.json'),
    communityCandidates: join(root, '.data-cache', 'community-audit-candidates.json'),
    libraryCandidates: join(root, '.data-cache', 'library-audit-candidates.json'),
    accidentCandidates: join(root, '.data-cache', 'accident-audit-candidates.json'),
    marketCandidates: join(root, '.data-cache', 'market-audit-candidates.json'),
  }
  const [
    manifest,
    priceAudit,
    riskAudit,
    facilityAudit,
    communityAudit,
    libraryAudit,
    accidentAudit,
    marketAudit,
    priceCandidateFile,
    riskCandidateFile,
    facilityCandidateFile,
    communityCandidateFile,
    libraryCandidateFile,
    accidentCandidateFile,
    marketCandidateFile,
  ] =
    await Promise.all([
      readJson(files.manifest),
      readJson(files.priceAudit),
      readJson(files.riskAudit),
      readJson(files.facilityAudit),
      readJson(files.communityAudit),
      readJson(files.libraryAudit),
      readJson(files.accidentAudit),
      readJson(files.marketAudit),
      readJson(files.priceCandidates),
      readJson(files.riskCandidates),
      readJson(files.facilityCandidates),
      readJson(files.communityCandidates),
      readJson(files.libraryCandidates),
      readJson(files.accidentCandidates),
      readJson(files.marketCandidates),
    ])
  assertAdapterVersion(priceAudit, priceCandidateFile)
  assertAdapterVersion(riskAudit, riskCandidateFile)
  assertAdapterVersion(facilityAudit, facilityCandidateFile)
  assertAdapterVersion(communityAudit, communityCandidateFile)
  assertAdapterVersion(libraryAudit, libraryCandidateFile)
  assertAdapterVersion(accidentAudit, accidentCandidateFile)
  assertAdapterVersion(marketAudit, marketCandidateFile)
  assertAuditPrivacy(priceAudit)
  assertAuditPrivacy(riskAudit)
  assertAuditPrivacy(facilityAudit)
  assertAuditPrivacy(communityAudit)
  assertAuditPrivacy(libraryAudit)
  assertAuditPrivacy(accidentAudit)
  assertAuditPrivacy(marketAudit)
  return {
    files,
    manifest,
    priceAudit,
    riskAudit,
    facilityAudit,
    communityAudit,
    libraryAudit,
    accidentAudit,
    marketAudit,
    priceCandidateFile,
    riskCandidateFile,
    facilityCandidateFile,
    communityCandidateFile,
    libraryCandidateFile,
    accidentCandidateFile,
    marketCandidateFile,
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

function facilityRecord(candidate, { result, attempts, evidence, now }) {
  if (!['matched', 'mismatch'].includes(result)) {
    throw new Error('設施 result 只接受 matched 或 mismatch')
  }
  if (evidence?.verificationMethod !== 'official-raw-offline') {
    throw new Error('設施稽核必須使用官方原始檔離線證據')
  }
  const fields = evidence.fields ?? {}
  const requiredFields = ['name', 'id', 'district', 'coordinate',
    ...(candidate.source === 'parking' ? ['carCapacity'] : []),
    ...(candidate.source === 'school' ? ['schoolLevels'] : []),
    ...(candidate.source === 'park' ? ['parkType'] : []),
    ...(candidate.source === 'market' ? ['marketOwnership', 'classificationMethod'] : [])]
  const allMatched = requiredFields
    .every((field) => fields[field] === true)
  if (result === 'matched' && !allMatched) {
    throw new Error('設施欄位不一致時必須記為 mismatch')
  }
  if (result === 'mismatch' && allMatched) {
    throw new Error('設施欄位全數一致時不得記為 mismatch')
  }
  return {
    id: candidate.id,
    source: candidate.source,
    city: candidate.city,
    district: candidate.district,
    result,
    verificationMethod: evidence.verificationMethod,
    fields,
    ...(candidate.schoolLevels ? { schoolLevels: candidate.schoolLevels } : {}),
    ...(candidate.parkType ? { parkType: candidate.parkType } : {}),
    ...(candidate.marketOwnership ? { marketOwnership: candidate.marketOwnership } : {}),
    ...(candidate.classificationMethod
      ? { classificationMethod: candidate.classificationMethod }
      : {}),
    evidence,
    checkedAt: now,
    attemptCount: attempts,
  }
}

function accidentRecord(candidate, { result, attempts, evidence, now }) {
  if (!['matched', 'mismatch'].includes(result)) throw new Error('事故 result 只接受 matched 或 mismatch')
  if (evidence?.verificationMethod !== 'official-raw-offline') {
    throw new Error('事故稽核必須使用官方原始檔離線證據')
  }
  const fields = evidence.fields ?? {}
  const allMatched = ['id', 'date', 'severity', 'district', 'coordinate']
    .every((field) => fields[field] === true)
  if ((result === 'matched') !== allMatched) throw new Error('事故欄位比對結果與 result 不一致')
  return {
    id: candidate.id,
    source: 'accidents',
    city: candidate.city,
    district: candidate.district,
    year: candidate.year,
    severity: candidate.severity,
    result,
    verificationMethod: evidence.verificationMethod,
    fields,
    evidence,
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
  const isRisk = ['flood', 'liquefaction'].includes(source)
  const isFacility = ['parking', 'medical'].includes(source)
  const isCommunity = ['school', 'park'].includes(source)
  const isLibrary = source === 'library'
  const isAccident = source === 'accidents'
  const isMarket = source === 'market'
  if (!isPrice && !isRisk && !isFacility && !isCommunity && !isLibrary && !isAccident && !isMarket) {
    throw new Error(`不支援的 source：${source}`)
  }
  const candidates = isPrice
    ? priceCandidates(context.priceCandidateFile)
    : isRisk
      ? riskCandidates(context.riskCandidateFile).filter((sample) => sample.source === source)
      : isAccident
        ? accidentCandidates(context.accidentCandidateFile)
        : isMarket
          ? marketCandidates(context.marketCandidateFile)
        : isLibrary
          ? libraryCandidates(context.libraryCandidateFile)
        : facilityCandidates(
        isCommunity ? context.communityCandidateFile : context.facilityCandidateFile,
      ).filter((sample) => sample.source === source)
  const candidate = candidates.find((sample) => sample.id === id)
  if (!candidate) throw new Error(`${source} 候選清單不存在 ID ${id}`)
  const audit = isPrice
    ? context.priceAudit
    : isRisk
      ? context.riskAudit
      : isCommunity
        ? context.communityAudit
        : isMarket
          ? context.marketAudit
        : isLibrary
          ? context.libraryAudit
        : isAccident ? context.accidentAudit : context.facilityAudit
  const existingIndex = audit.samples.findIndex((sample) => sample.id === id)
  if (existingIndex >= 0 && !replace) {
    throw new Error(`${id} 已有稽核紀錄；確認重做時請加 --replace`)
  }
  const record = isPrice
    ? priceRecord(candidate, { result, attempts, mismatchFields, now })
    : isRisk
      ? riskRecord(candidate, { result, observed, attempts, evidence, now })
      : isAccident
        ? accidentRecord(candidate, { result, attempts, evidence, now })
        : facilityRecord(candidate, { result, attempts, evidence, now })
  if (existingIndex >= 0) audit.samples[existingIndex] = record
  else audit.samples.push(record)
  audit.checkedAt = now

  const nextContext = {
    price: isPrice ? audit : context.priceAudit,
    risks: isRisk ? audit : context.riskAudit,
    facilities: isFacility ? audit : context.facilityAudit,
    community: isCommunity ? audit : context.communityAudit,
    library: isLibrary ? audit : context.libraryAudit,
    accidents: isAccident ? audit : context.accidentAudit,
    market: isMarket ? audit : context.marketAudit,
  }
  const progress = readiness(nextContext, context.manifest)
  if (isPrice) audit.status = progress.price.passed ? 'passed' : 'pending'
  else audit.status =
    isRisk
      ? progress.flood.passed && progress.liquefaction.passed ? 'passed' : 'pending'
      : isAccident
        ? progress.accidents.passed ? 'passed' : 'pending'
        : isMarket
          ? progress.market.passed ? 'passed' : 'pending'
        : isLibrary
          ? progress.library.passed ? 'passed' : 'pending'
        : isCommunity
        ? progress.school.passed && progress.park.passed ? 'passed' : 'pending'
        : progress.parking.passed && progress.medical.passed ? 'passed' : 'pending'
  assertAuditPrivacy(audit)
  await writeJsonAtomic(
    isPrice
      ? context.files.priceAudit
      : isRisk
        ? context.files.riskAudit
        : isCommunity
        ? context.files.communityAudit
        : isLibrary
          ? context.files.libraryAudit
        : isAccident
          ? context.files.accidentAudit
          : isMarket
            ? context.files.marketAudit
          : context.files.facilityAudit,
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
    facilities: context.facilityAudit,
    community: context.communityAudit,
    library: context.libraryAudit,
    accidents: context.accidentAudit,
    market: context.marketAudit,
  }, context.manifest)
  const priceSamples = context.priceAudit.samples
  const riskSamples = context.riskAudit.samples
  const facilitySamples = context.facilityAudit.samples
  const communitySamples = context.communityAudit.samples
  const librarySamples = context.libraryAudit.samples
  const accidentSamples = context.accidentAudit.samples
  const marketSamples = context.marketAudit.samples
  return {
    ...progress,
    adapterVersions: {
      price: context.priceAudit.adapterVersion,
      risks: context.riskAudit.adapterVersion,
      facilities: context.facilityAudit.adapterVersion,
      community: context.communityAudit.adapterVersion,
      library: context.libraryAudit.adapterVersion,
      accidents: context.accidentAudit.adapterVersion,
      market: context.marketAudit.adapterVersion,
    },
    inconclusive: priceSamples.filter((sample) => sample.result === 'inconclusive').length,
    mismatches: [...priceSamples, ...riskSamples, ...facilitySamples, ...communitySamples, ...librarySamples, ...marketSamples, ...accidentSamples]
      .filter((sample) => sample.result === 'mismatch').length,
    verificationMethods: Object.fromEntries(['flood', 'liquefaction'].map((source) => [
      source,
      [...new Set(riskSamples
        .filter((sample) => sample.source === source && sample.result === 'matched')
        .map((sample) => sample.verificationMethod)
        .filter(Boolean))],
    ])),
    facilityVerificationMethods: Object.fromEntries(
      ['parking', 'medical', 'school', 'park', 'library', 'market'].map((source) => [
        source,
        [...new Set([...facilitySamples, ...communitySamples, ...librarySamples, ...marketSamples]
        .filter((sample) => sample.source === source && sample.result === 'matched')
        .map((sample) => sample.verificationMethod)
        .filter(Boolean))],
      ]),
    ),
    accidentVerificationMethods: [...new Set(accidentSamples
      .filter((sample) => sample.result === 'matched')
      .map((sample) => sample.verificationMethod)
      .filter(Boolean))],
  }
}

export { assertAuditPrivacy }
