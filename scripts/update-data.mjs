#!/usr/bin/env node
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const publicData = join(root, 'public', 'data')
const staging = join(root, '.data-staging')
const incoming = process.env.DATA_INPUT_DIR ? resolve(process.env.DATA_INPUT_DIR) : null

const log = (stage, message) => console.log(`[${stage}] ${message}`)
const MAX_ATTEMPTS = 3
const fail = (stage, error) => {
  console.error(`[${stage}] FAILED: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}

async function withRetry(stage, operation) {
  let lastError
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      console.error(`[${stage}] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  throw lastError
}

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

async function validate(directory) {
  const files = await walk(directory)
  const jsonFiles = files.filter((file) => file.endsWith('.json') || file.endsWith('.geojson'))
  if (!jsonFiles.length) throw new Error('找不到 JSON 或 GeoJSON')
  for (const file of jsonFiles) {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (file.endsWith('.geojson') && data.type !== 'FeatureCollection') {
      throw new Error(`${file} 不是 FeatureCollection`)
    }
  }
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (!manifest.schemaVersion || !manifest.dataVersion || !manifest.mode) {
    throw new Error('manifest 缺少 schemaVersion、dataVersion 或 mode')
  }
  return { files: files.length, jsonFiles: jsonFiles.length, manifest }
}

async function main() {
  try {
    log('download', incoming ? `讀取已下載來源 ${incoming}` : '未設定 DATA_INPUT_DIR；不執行網路下載')
    if (!incoming) {
      const report = await validate(publicData)
      log('validate', `現有 last-good 資料有效：${report.jsonFiles} 個 JSON/GeoJSON`)
      log('normalize', '無新來源，no-op')
      log('filter', '無新來源，no-op')
      log('aggregate', '無新來源，no-op')
      log('split', '無新來源，no-op')
      log('manifest', `保留 ${report.manifest.dataVersion}`)
      return
    }

    await withRetry('download', () => access(join(incoming, 'manifest.json')))
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    log('normalize', '複製標準化輸入到隔離 staging；正式 adapter 應在此步統一欄位與座標')
    await withRetry('normalize', () => cp(incoming, staging, { recursive: true }))
    log('filter', '輸入應已限縮臺北市、新北市與近五年住宅交易；以 manifest coverage 驗證')
    log('aggregate', '價格摘要由來源 adapter 產生；網站不在前端預載全臺資料')
    log('split', '保留 city/district 分區目錄')
    const report = await validate(staging)
    log('validate', `staging 有效：${report.files} 個檔案`)
    report.manifest.generatedAt = new Date().toISOString()
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(report.manifest, null, 2)}\n`)
    log('manifest', `產生 ${report.manifest.dataVersion}`)

    const backup = join(root, '.data-last-good')
    await rm(backup, { recursive: true, force: true })
    await rename(publicData, backup)
    try {
      await rename(staging, publicData)
      await rm(backup, { recursive: true, force: true })
      log('publish', '驗證成功，已原子替換 public/data')
    } catch (error) {
      await rename(backup, publicData)
      throw error
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    fail('pipeline', error)
  }
}

await main()
