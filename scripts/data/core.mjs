import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import proj4 from 'proj4'

proj4.defs('EPSG:3826', '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs')

export const MAX_ATTEMPTS = 3
export const SQM_PER_PING = 3.305785

export function parseCsvLine(line) {
  const values = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      values.push(value)
      value = ''
    } else {
      value += character
    }
  }
  values.push(value)
  return values
}

export function rowObject(headers, values) {
  return Object.fromEntries(headers.map((header, index) => [header.replace(/^\uFEFF/, ''), values[index] ?? '']))
}

export async function* csvRows(input) {
  const lines = createInterface({ input, crlfDelay: Infinity })
  let headers
  for await (const line of lines) {
    if (!line.trim()) continue
    const values = parseCsvLine(line)
    if (!headers) {
      headers = values.map((value) => value.replace(/^\uFEFF/, ''))
      continue
    }
    if (/^The villages and towns urban district$/i.test(values[0])) continue
    yield rowObject(headers, values)
  }
}

export function csvFileRows(file) {
  return csvRows(createReadStream(file))
}

export async function withRetry(stage, operation, logger = console) {
  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      logger.error(`[${stage}] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  throw lastError
}

export async function downloadFile(url, destination, fetcher = fetch) {
  const temporary = `${destination}.part`
  await withRetry('download', async () => {
    const response = await fetcher(url, { headers: { 'user-agent': 'homecheck-tw-data-pipeline/1.0' } })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) throw new Error(`HTML response from ${url}`)
    if (!response.body) throw new Error(`empty response from ${url}`)
    const file = await open(temporary, 'w')
    try {
      await pipeline(Readable.fromWeb(response.body), file.createWriteStream())
    } finally {
      await file.close()
    }
  })
  await rename(temporary, destination)
  return destination
}

export function parseRocDate(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length < 6 || digits.length > 7) return null
  const yearDigits = digits.slice(0, -4)
  const year = Number(yearDigits) + 1911
  const month = Number(digits.slice(-4, -2))
  const day = Number(digits.slice(-2))
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function sqmToPing(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.round((number / SQM_PER_PING) * 100) / 100
    : 0
}

const buildingTypes = [
  ['公寓(5樓含以下無電梯)', 'apartment'],
  ['華廈(10層含以下有電梯)', 'mansion'],
  ['住宅大樓(11層含以上有電梯)', 'highrise'],
]

export function normalizeBuildingType(value) {
  const text = String(value ?? '').replace(/\s/g, '')
  return buildingTypes.find(([label]) => text.includes(label))?.[1] ?? null
}

const chineseDigits = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

export function parseChineseNumber(value) {
  const text = String(value ?? '').trim()
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  const ten = text.indexOf('十')
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : chineseDigits[text[ten - 1]]
    const ones = ten === text.length - 1 ? 0 : chineseDigits[text[ten + 1]]
    return tens === undefined || ones === undefined ? null : tens * 10 + ones
  }
  return chineseDigits[text] ?? null
}

export function parseFloor(value) {
  const text = String(value ?? '').normalize('NFKC')
  if (!text || /地下|夾層|屋頂|見其他登記事項/.test(text)) return 0
  const matches = [...text.matchAll(/([0-9零〇一二兩三四五六七八九十]+)層/g)]
  if (matches.length !== 1) return 0
  return parseChineseNumber(matches[0][1]) ?? 0
}

export function normalizeAddress(value, city = '', district = '') {
  let address = String(value ?? '')
    .normalize('NFKC')
    .replace(/[臺台]北市|新北市/g, '')
    .replace(city, '')
    .replace(district, '')
    .replace(/[()（）內單雙]/g, '')
    .replace(/[－–—-](\d+)/g, '之$1')
    .replace(/[,.，、\s]/g, '')
  const throughNumber = address.match(/^(.+?號(?:之\d+)?)/)
  if (throughNumber) address = throughNumber[1]
  return address
}

export function twd97ToWgs84(x, y) {
  const longitudeLatitude = proj4('EPSG:3826', 'EPSG:4326', [Number(x), Number(y)])
  if (!longitudeLatitude.every(Number.isFinite)) return null
  return {
    longitude: Math.round(longitudeLatitude[0] * 1e7) / 1e7,
    latitude: Math.round(longitudeLatitude[1] * 1e7) / 1e7,
  }
}

export function inTaipeiMetroArea({ latitude, longitude }) {
  return latitude >= 24.65 && latitude <= 25.32 && longitude >= 121.28 && longitude <= 122.02
}

export function stableId(fields) {
  return createHash('sha256').update(fields.map((field) => String(field ?? '').trim()).join('|')).digest('hex').slice(0, 24)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function isSpecialTransaction(note) {
  return /親友|員工|共有人|特殊關係|急買急賣|法院拍賣|債務抵償|毛胚屋|瑕疵|增建|違建|畸零地|政府機關|協議價購|包含公共設施保留地/.test(String(note ?? ''))
}

export function calculateNormalizedUnitPrice(totalPrice, areaPing, parkingPrice = 0, parkingAreaPing = 0) {
  const netArea = areaPing - Math.max(0, parkingAreaPing)
  if (!(netArea > 0)) return null
  return Math.round(((totalPrice - Math.max(0, parkingPrice)) / netArea) * 100) / 100
}
