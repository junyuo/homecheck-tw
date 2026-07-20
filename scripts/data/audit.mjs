const PRICE_FIELDS = [
  'date',
  'totalPrice',
  'areaSquareMeters',
  'buildingType',
  'floor',
  'parkingPrice',
  'parkingAreaSquareMeters',
]

function uniqueMatchedSamples(samples, predicate) {
  return new Map(samples
    .filter((sample) => sample.result === 'matched' && predicate(sample))
    .map((sample) => [sample.id, sample])).values()
}

export function evaluatePriceAudit(audit, {
  adapterVersion,
} = {}) {
  const samples = Array.isArray(audit?.samples) ? audit.samples : []
  const mismatches = samples.filter((sample) => sample.result === 'mismatch').length
  const counts = {}
  const typeCoverage = {}
  for (const city of ['taipei', 'new-taipei']) {
    const matched = [...uniqueMatchedSamples(samples, (sample) =>
      sample.city === city &&
      PRICE_FIELDS.every((field) => sample.fields?.[field] === true))]
    counts[city] = matched.length
    typeCoverage[city] = new Set(matched.map((sample) => sample.buildingType)).size
  }
  const passed = audit?.status === 'passed' &&
    audit?.adapterVersion === adapterVersion &&
    counts.taipei >= 10 &&
    counts['new-taipei'] >= 10 &&
    typeCoverage.taipei === 3 &&
    typeCoverage['new-taipei'] === 3 &&
    mismatches === 0
  return {
    passed,
    sampleCount: counts.taipei + counts['new-taipei'],
    requiredSampleCount: 20,
    counts,
    mismatches,
  }
}

function riskCoveragePassed(source, samples) {
  for (const city of ['taipei', 'new-taipei']) {
    const citySamples = [...uniqueMatchedSamples(samples, (sample) =>
      sample.source === source &&
      sample.city === city &&
      sample.observedCategory === sample.expectedCategory &&
      ['official-map', 'official-raw-offline'].includes(sample.verificationMethod) &&
      Number.isFinite(sample.latitude) &&
      Number.isFinite(sample.longitude) &&
      (String(sample.latitude).split('.')[1] ?? '').length <= 5 &&
      (String(sample.longitude).split('.')[1] ?? '').length <= 5)]
    if (citySamples.length < 5) return false
    const cases = citySamples.map((sample) => sample.caseType)
    if (source === 'flood') {
      const redCategories = new Set(citySamples
        .filter((sample) => sample.caseType === 'red')
        .map((sample) => sample.expectedCategory))
      if (redCategories.size < 2 ||
          cases.filter((value) => value === 'yellow').length < 2 ||
          !cases.includes('unknown')) return false
    } else if (!['high', 'medium', 'low', 'uncovered']
      .every((value) => cases.includes(value))) {
      return false
    }
  }
  return true
}

export function evaluateRiskAudit(audit, source, {
  adapterVersion,
  sourceSha256,
  requireEvidenceSourceSha = false,
} = {}) {
  const samples = Array.isArray(audit?.samples) ? audit.samples : []
  const sourceSamples = samples.filter((sample) => sample.source === source)
  const mismatches = sourceSamples.filter((sample) => sample.result === 'mismatch').length
  const counts = Object.fromEntries(['taipei', 'new-taipei'].map((city) => [
    city,
    [...uniqueMatchedSamples(sourceSamples, (sample) => sample.city === city)].length,
  ]))
  const offlineEvidenceValid = !requireEvidenceSourceSha || sourceSamples
    .filter((sample) => sample.verificationMethod === 'official-raw-offline')
    .every((sample) =>
      sample.evidence?.sourceSha256 === sourceSha256 &&
      /^[a-f0-9]{64}$/.test(sample.evidence?.queryOutputSha256 ?? ''))
  const passed = audit?.status === 'passed' &&
    audit?.adapterVersion === adapterVersion &&
    mismatches === 0 &&
    offlineEvidenceValid &&
    riskCoveragePassed(source, sourceSamples)
  const verificationMethods = [...new Set(sourceSamples
    .filter((sample) => sample.result === 'matched')
    .map((sample) => sample.verificationMethod)
    .filter(Boolean))]
  return {
    passed,
    sampleCount: counts.taipei + counts['new-taipei'],
    requiredSampleCount: 10,
    counts,
    mismatches,
    verificationMethods,
  }
}

export function manualGate(evaluation, adapterVersion, checkedAt) {
  return {
    status: evaluation.passed ? 'passed' : 'pending',
    adapterVersion,
    checkedAt: checkedAt ?? null,
    sampleCount: evaluation.sampleCount,
    requiredSampleCount: evaluation.requiredSampleCount,
    ...(evaluation.verificationMethods?.length
      ? { verificationMethods: evaluation.verificationMethods }
      : {}),
  }
}

export function evaluateRailAudit(audit, {
  adapterVersion,
} = {}) {
  const samples = Array.isArray(audit?.samples) ? audit.samples : []
  const mismatches = samples.filter((sample) => sample.result === 'mismatch').length
  const counts = Object.fromEntries(['taipei', 'new-taipei'].map((city) => [
    city,
    [...uniqueMatchedSamples(samples, (sample) =>
      sample.city === city &&
      ['name', 'address', 'district', 'gps']
        .every((field) => sample.fields?.[field] === true))].length,
  ]))
  const passed = audit?.status === 'passed' &&
    audit?.adapterVersion === adapterVersion &&
    counts.taipei >= 4 &&
    counts['new-taipei'] >= 5 &&
    mismatches === 0
  return {
    passed,
    sampleCount: counts.taipei + counts['new-taipei'],
    requiredSampleCount: 9,
    counts,
    mismatches,
  }
}

export const PRICE_AUDIT_FIELDS = PRICE_FIELDS
