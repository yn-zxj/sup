import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Send,
  Loader2,
  Bot,
  User,
  Wrench,
  ShieldAlert,
  Clock,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Settings,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AiSettingsDialog } from '@/components/ai-settings-dialog'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'approval' | 'system'
  content: string
  toolName?: string
  toolArgs?: string
  toolOutput?: string
  approvalId?: string
  command?: string
  risk?: string
  timestamp: number
  expanded?: boolean
}

interface AiChatPanelProps {
  host: string
  onCommandApprove?: (approvalId: string) => void
  onCommandReject?: (approvalId: string) => void
}

export function AiChatPanel({ host, onCommandApprove, onCommandReject }: AiChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streaming])

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages((prev) => [...prev, { ...msg, id, timestamp: Date.now() }])
  }, [])

  const updateLastAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content }]
      }
      return prev
    })
  }, [])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setLoading(true)

    addMessage({ role: 'user', content: text })

    try {
      // 使用 SSE 流式连接 AI 服务
      const response = await fetch('/api/ai/chat-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, message: text }),
      })

      if (!response.ok) {
        throw new Error(`AI 服务错误: ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('无法读取响应流')

      const decoder = new TextDecoder()
      let buffer = ''
      let currentAssistant = ''

      addMessage({ role: 'assistant', content: '' })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const event = JSON.parse(data)
            switch (event.type) {
              case 'text':
                currentAssistant += event.content
                updateLastAssistant(currentAssistant)
                setStreaming(event.content)
                break
              case 'tool_start':
                addMessage({
                  role: 'tool',
                  content: `调用工具: ${event.toolName}`,
                  toolName: event.toolName,
                  toolArgs: event.content,
                })
                break
              case 'tool_end':
                addMessage({
                  role: 'tool',
                  content: event.toolOutput?.slice(0, 200) || '',
                  toolName: event.toolName,
                  toolOutput: event.toolOutput,
                })
                break
              case 'error':
                addMessage({ role: 'system', content: `错误: ${event.content}` })
                break
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      }
    } catch (err) {
      addMessage({
        role: 'system',
        content: `连接 AI 服务失败: ${(err as Error).message}。请确保 AI 服务已启动。`,
      })
    } finally {
      setLoading(false)
      setStreaming('')
    }
  }

  // SSE 审批事件流（替代轮询）
  useEffect(() => {
    const es = new EventSource('/api/ai/approvals-stream')

    es.addEventListener('new', (e) => {
      try {
        const a = JSON.parse(e.data) as ApprovalItem
        setMessages((prev) => {
          const exists = prev.some((m) => m.approvalId === a.id)
          if (exists) return prev
          return [
            ...prev,
            {
              id: `apr-${a.id}`,
              role: 'approval' as const,
              content: `等待审批: ${a.command}`,
              approvalId: a.id,
              command: a.command,
              risk: a.risk,
              timestamp: Date.now(),
            },
          ]
        })
      } catch {
        /* ignore parse error */
      }
    })

    es.addEventListener('approved', (e) => {
      try {
        const { id } = JSON.parse(e.data)
        setMessages((prev) =>
          prev.map((m) =>
            m.approvalId === id ? { ...m, role: 'system' as const, content: `已批准: ${m.command}` } : m
          )
        )
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('rejected', (e) => {
      try {
        const { id } = JSON.parse(e.data)
        setMessages((prev) =>
          prev.map((m) =>
            m.approvalId === id ? { ...m, role: 'system' as const, content: `已拒绝: ${m.command}` } : m
          )
        )
      } catch {
        /* ignore */
      }
    })

    es.onerror = () => {
      // 连接断开会自动重连，无需处理
    }

    return () => es.close()
  }, [])

  const handleApprove = async (approvalId: string) => {
    try {
      await fetch(`/api/ai/approve/${encodeURIComponent(approvalId)}`, { method: 'POST' })
      // 状态更新由 SSE 事件流自动处理
      onCommandApprove?.(approvalId)
    } catch {
      /* ignore */
    }
  }

  const handleReject = async (approvalId: string) => {
    try {
      await fetch(`/api/ai/reject/${encodeURIComponent(approvalId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '用户拒绝' }),
      })
      // 状态更新由 SSE 事件流自动处理
      onCommandReject?.(approvalId)
    } catch {
      /* ignore */
    }
  }

  const renderMessage = (msg: ChatMessage) => {
    switch (msg.role) {
      case 'user':
        return (
          <div key={msg.id} className="flex items-start gap-2 justify-end">
            <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm max-w-[80%] break-words">
              {msg.content}
            </div>
            <div className="bg-primary/20 rounded-full p-1 shrink-0">
              <User className="size-3.5" />
            </div>
          </div>
        )

      case 'assistant':
        return (
          <div key={msg.id} className="flex items-start gap-2">
            <div className="bg-muted rounded-full p-1 shrink-0">
              <Bot className="size-3.5" />
            </div>
            <div className="bg-muted rounded-lg px-3 py-2 text-sm max-w-[85%]">
              {msg.content ? (
                <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-sm prose-p:leading-relaxed prose-code:text-xs prose-code:bg-muted-foreground/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-zinc-950 prose-pre:text-zinc-100 prose-pre:text-xs prose-pre:rounded-lg prose-a:text-primary prose-strong:text-foreground prose-li:text-sm prose-table:text-xs">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  思考中...
                </span>
              )}
            </div>
          </div>
        )

      case 'tool':
        return (
          <div key={msg.id} className="flex items-start gap-2">
            <div className="bg-amber-100 dark:bg-amber-900/30 rounded-full p-1 shrink-0">
              <Wrench className="size-3.5 text-amber-600" />
            </div>
            <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-1.5 text-xs max-w-[85%]">
              <button
                className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400 w-full text-left"
                onClick={() =>
                  setMessages((prev) =>
                    prev.map((m) => (m.id === msg.id ? { ...m, expanded: !m.expanded } : m))
                  )
                }
              >
                {msg.expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                工具: {msg.toolName}
              </button>
              {msg.expanded && (
                <pre className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap overflow-x-auto max-h-24">
                  {msg.toolOutput || msg.toolArgs || ''}
                </pre>
              )}
            </div>
          </div>
        )

      case 'approval':
        return (
          <div key={msg.id} className="flex items-start gap-2">
            <div className="bg-red-100 dark:bg-red-900/30 rounded-full p-1 shrink-0">
              <ShieldAlert className="size-3.5 text-red-600" />
            </div>
            <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-xs max-w-[85%] w-full">
              <div className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-400 mb-1.5">
                <ShieldAlert className="size-3.5" />
                危险操作需要审批
              </div>
              <code className="block bg-red-100 dark:bg-red-900/40 rounded px-2 py-1 text-[11px] mb-2 font-mono break-all whitespace-pre-wrap">
                {msg.command}
              </code>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="text-red-600 text-[10px]">
                  {msg.risk === 'dangerous' ? '不可逆操作' : '需确认'}
                </Badge>
                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                  <Clock className="size-2.5" /> 30s 超时自动拒绝
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] text-red-600 hover:bg-red-50"
                    onClick={() => msg.approvalId && handleReject(msg.approvalId)}
                  >
                    <X className="size-3" /> 拒绝
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 text-[10px] bg-green-600 hover:bg-green-700"
                    onClick={() => msg.approvalId && handleApprove(msg.approvalId)}
                  >
                    <Check className="size-3" /> 批准
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )

      case 'system':
        return (
          <div key={msg.id} className="flex justify-center">
            <span className={`text-[11px] px-2 py-1 rounded max-w-[92%] break-all ${
              msg.content.startsWith('错误') || msg.content.startsWith('连接')
                ? 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
                : 'text-muted-foreground bg-muted/50'
            }`}>
              {msg.content}
            </span>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Bot className="size-4 text-primary" />
        <span className="text-sm font-medium">AI 助手</span>
        <button
          className="ml-1 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          onClick={() => setSettingsOpen(true)}
          title="AI 设置"
        >
          <Settings className="size-3.5" />
        </button>
        <Badge variant="secondary" className="text-[10px] ml-auto">
          {host}
        </Badge>
      </div>

      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Bot className="size-8 opacity-20 mb-2" />
            <p className="text-sm">问我关于主机 {host} 的任何问题</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              例如：「巡检主机」「检查磁盘空间」「查看 Nginx 配置」
            </p>
          </div>
        )}
        {messages.map(renderMessage)}
      </div>

      {/* 输入框 */}
      <div className="border-t p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            sendMessage()
          }}
          className="flex gap-1.5"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入消息..."
            className="h-8 text-sm"
            disabled={loading}
          />
          <Button type="submit" size="icon" className="size-8 shrink-0" disabled={loading || !input.trim()}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          </Button>
        </form>
      </div>
      <AiSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  )
}

interface ApprovalItem {
  id: string
  command: string
  risk: string
  host: string
}
