/**
 * AI Service 入口
 * Express HTTP 服务器，提供 AI Agent 聊天接口
 */
import express, { type Request, type Response } from 'express'
import { getConfig } from './config.js'
import { runAgentStream } from './agent.js'

const app = express()
app.use(express.json())

// ---- 请求日志中间件 ----
app.use((req: Request, _res: Response, next) => {
  const ts = new Date().toISOString().slice(11, 19)
  const body = req.method === 'POST' ? JSON.stringify(req.body) : ''
  console.log(`[AI] ${ts} ${req.method} ${req.path} ${body}`.trim())
  next()
})

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

  console.log(`[AI] 开始处理: host=${host} mode=${mode || 'assistant'} msg="${message.slice(0, 80)}"`)

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const startTime = Date.now()
  try {
    const stream = runAgentStream(host, message, mode || 'assistant')

    for await (const event of stream) {
      const data = JSON.stringify(event)
      res.write(`data: ${data}\n\n`)

      // 打印关键事件
      switch (event.type as string) {
        case 'tool_start':
          console.log(`[AI] 🔧 调用工具: ${(event as { toolName: string }).toolName}`)
          break
        case 'tool_end':
          console.log(`[AI] ✅ 工具完成: ${(event as { toolName: string }).toolName}`)
          break
        case 'text':
          // 太长截断
          const content = (event as { content: string }).content
          if (content.length > 200) {
            console.log(`[AI] 📝 LLM 输出 (${content.length} chars): ${content.slice(0, 200)}...`)
          } else {
            console.log(`[AI] 📝 ${content}`)
          }
          break
        case 'done':
          console.log(`[AI] 🏁 完成，耗时 ${Date.now() - startTime}ms`)
          break
        case 'error':
          console.error(`[AI] ❌ 错误: ${(event as { content: string }).content}`)
          break
        case 'approval_required':
          console.log(`[AI] 🔒 审批: ${(event as unknown as { command: string }).command}`)
          break
      }
    }
  } catch (err) {
    console.error(`[AI] ❌ 异常 (${Date.now() - startTime}ms): ${(err as Error).message}`)
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

  console.log(`[AI] 同步处理: host=${host} mode=${mode || 'assistant'}`)

  try {
    const stream = runAgentStream(host, message, mode || 'assistant')
    const events: unknown[] = []

    for await (const event of stream) {
      events.push(event)
      if (event.type === 'done' || event.type === 'error') break
    }

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
    console.error(`[AI] 同步处理失败: ${(err as Error).message}`)
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
    hasApiKey: !!config.apiKey,
  })
})

// 启动服务
const config = getConfig()

if (!config.enabled) {
  console.log('[AI] AI 服务已禁用')
  process.exit(0)
}

// 打印配置来源
console.log('[AI] === 配置加载 ===')
console.log(`[AI] Provider : ${config.provider}`)
console.log(`[AI] Base URL : ${config.baseUrl}`)
console.log(`[AI] Model    : ${config.model}`)
console.log(`[AI] Port     : ${config.port}`)
console.log(`[AI] API Key  : ${config.apiKey ? `已配置 (${config.apiKey.slice(0, 7)}...)` : '❌ 未配置'}`)
console.log(`[AI] Backend  : ${config.backendUrl}`)
console.log('[AI] ================')

if (!config.apiKey) {
  console.warn('[AI] ⚠️  未配置 API Key，聊天功能将无法使用')
}

app.listen(config.port, () => {
  console.log(`[AI] AI 服务已启动: http://127.0.0.1:${config.port}`)
})

export default app
