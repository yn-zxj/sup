/**
 * AI 服务配置加载
 * 优先从环境变量 SUP_AI_* 读取（Rust 子进程传入），再回退到 ~/.config/sup/ai.toml
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface AIConfig {
  enabled: boolean
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  port: number
  backendUrl: string
}

let cached: AIConfig | null = null

function parseTomlLike(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.substring(0, eq).trim()
    let value = trimmed.substring(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function loadConfig(): AIConfig {
  // 1. 从环境变量读取（Rust 子进程通过 SUP_AI_* 传入，优先级最高）
  const envProvider = process.env.SUP_AI_PROVIDER
  const envBaseUrl = process.env.SUP_AI_BASE_URL
  const envModel = process.env.SUP_AI_MODEL
  const envPort = process.env.SUP_AI_PORT
  const envApiKey = process.env.SUP_AI_API_KEY
  const envBackendUrl = process.env.SUP_BACKEND_URL
  const envEnabled = process.env.SUP_AI_ENABLED

  const defaults: AIConfig = {
    enabled: envEnabled !== undefined ? envEnabled === 'true' : true,
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    port: 7799,
    backendUrl: 'http://127.0.0.1:7788',
  }

  // 2. 从文件读取作为兜底
  try {
    const configPath = join(homedir(), '.config', 'sup', 'ai.toml')
    const content = readFileSync(configPath, 'utf-8')
    const parsed = parseTomlLike(content)

    if (parsed.provider) defaults.provider = parsed.provider
    if (parsed.api_key) defaults.apiKey = parsed.api_key
    if (parsed.base_url) defaults.baseUrl = parsed.base_url
    if (parsed.model) defaults.model = parsed.model
    if (parsed.port) defaults.port = parseInt(parsed.port, 10) || 7799
    if (parsed.enabled !== undefined) defaults.enabled = parsed.enabled === 'true'
  } catch {
    // 配置文件不存在，使用默认值
  }

  // 3. 环境变量覆盖文件配置（最高优先级）
  if (envProvider) defaults.provider = envProvider
  if (envBaseUrl) defaults.baseUrl = envBaseUrl
  if (envModel) defaults.model = envModel
  if (envPort) defaults.port = parseInt(envPort, 10) || 7799
  if (envApiKey) defaults.apiKey = envApiKey
  if (envBackendUrl) defaults.backendUrl = envBackendUrl

  // 也兼容标准 OPENAI_* 环境变量
  if (process.env.OPENAI_API_KEY && !defaults.apiKey) {
    defaults.apiKey = process.env.OPENAI_API_KEY
  }
  if (process.env.OPENAI_BASE_URL) {
    defaults.baseUrl = process.env.OPENAI_BASE_URL
  }

  return defaults
}

export function getConfig(): AIConfig {
  if (!cached) {
    cached = loadConfig()
  }
  return cached
}

export function reloadConfig(): AIConfig {
  cached = null
  return getConfig()
}
