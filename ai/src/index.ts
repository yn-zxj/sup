/**
 * AI Service 入口
 * Express HTTP 服务器，提供 AI Agent 聊天接口
 */
import express, { type Request, type Response } from 'express'
import { getConfig } from './config.js'
import { runAgentStream } from './agent.js'

const app = express()
app.use(express.json())

// SSE 流式聊天端点
app.post('/chat/stream', async (req: Request, res: Response) => {
  const { host, message, mode } = req.body as {
    host?: string
    message?: string
    mode?: 'assistant' | 'inspector'
  }

  if (!host || !message) {
    res.status(400).json({ error: '缺少 host 或 message 参数' })
    return
  }

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  try {
    const stream = runAgentStream(host, message, mode || 'assistant')

    for await (const event of stream) {
      const data = JSON.stringify(event)
      res.write(`data: ${data}\n\n`)
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: (err as Error).message })}\n\n`)
  } finally {
    res.end()
  }
})

// 同步聊天端点（非流式）
app.post('/chat', async (req: Request, res: Response) => {
  const { host, message, mode } = req.body as {
    host?: string
    message?: string
    mode?: 'assistant' | 'inspector'
  }

  if (!host || !message) {
    res.status(400).json({ error: '缺少 host 或 message 参数' })
    return
  }

  try {
    const stream = runAgentStream(host, message, mode || 'assistant')
    const events: unknown[] = []

    for await (const event of stream) {
      events.push(event)
      if (event.type === 'done' || event.type === 'error') break
    }

    // 收集所有文本回复
    const texts = events
      .filter((e) => (e as { type: string }).type === 'text')
      .map((e) => (e as { content: string }).content)
      .join('')

    const toolCalls = events.filter(
      (e) => (e as { type: string }).type === 'tool_start' || (e as { type: string }).type === 'tool_end'
    )

    res.json({
      reply: texts,
      toolCalls,
      events,
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// 健康检查
app.get('/health', (_req: Request, res: Response) => {
  const config = getConfig()
  res.json({
    status: 'ok',
    provider: config.provider,
    model: config.model,
  })
})

// 启动服务
const config = getConfig()

if (!config.enabled) {
  console.log('[AI] AI 服务已禁用')
  process.exit(0)
}

if (!config.apiKey) {
  console.warn('[AI] ⚠️  未配置 API Key，AI 功能无法使用')
  console.warn('[AI] 请在 ~/.config/sup/ai.toml 或环境变量 OPENAI_API_KEY 中配置')
}

app.listen(config.port, () => {
  console.log(`[AI] AI 服务已启动: http://127.0.0.1:${config.port}`)
  console.log(`[AI] Provider: ${config.provider}, Model: ${config.model}`)
})

export default app
