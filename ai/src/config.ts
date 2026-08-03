/**
 * AI 服务配置加载
 * 从 ~/.config/sup/ai.toml 或环境变量读取
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
  // Rust 后端地址
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
    // 去除引号
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function loadConfig(): AIConfig {
  const defaults: AIConfig = {
    enabled: true,
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    port: 7799,
    backendUrl: 'http://127.0.0.1:7788',
  }

  try {
    const configPath = join(homedir(), '.config', 'sup', 'ai.toml')
    const content = readFileSync(configPath, 'utf-8')
    const parsed = parseTomlLike(content)
    
    if (parsed.enabled !== undefined) defaults.enabled = parsed.enabled === 'true'
    if (parsed.provider) defaults.provider = parsed.provider
    if (parsed.api_key) defaults.apiKey = parsed.api_key
    if (parsed.base_url) defaults.baseUrl = parsed.base_url
    if (parsed.model) defaults.model = parsed.model
    if (parsed.port) defaults.port = parseInt(parsed.port, 10) || 7799
  } catch {
    // 配置文件不存在，使用默认值
    console.log('[AI] 未找到 ai.toml 配置文件，使用默认配置')
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
