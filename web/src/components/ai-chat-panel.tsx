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
  ShieldCheck,
  Clock,
  Check,
  X,
  Copy,
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
  toolStatus?: 'running' | 'done' | 'failed'
  toolCallId?: string
  approvalId?: string
  command?: string
  risk?: string
  timestamp: number
  createdAt?: number
  expanded?: boolean
  resolved?: 'approved' | 'rejected'
}

interface AiChatPanelProps {
  host: string
  onCommandApprove?: (approvalId: string) => void
  onCommandReject?: (approvalId: string) => void
}

/** Markdown 渲染组件（带错误兜底，表格支持横向滚动） */
function MarkdownContent({ content }: { content: string }) {
  try {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-sm prose-p:leading-relaxed prose-code:text-xs prose-code:bg-muted-foreground/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-zinc-950 prose-pre:text-zinc-100 prose-pre:text-xs prose-pre:rounded-lg prose-a:text-primary prose-strong:text-foreground prose-li:text-sm prose-table:text-xs">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: ({ children }) => (
              <div className="overflow-x-auto">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    )
  } catch {
    // 渲染失败时回退到纯文本
    return <pre className="text-xs whitespace-pre-wrap break-all max-h-96 overflow-auto">{content}</pre>
  }
}

export function AiChatPanel({ host, onCommandApprove, onCommandReject }: AiChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 跟踪本轮对话是否已经历过工具调用，用于将最终总结放到工具消息后面
  const hasToolsRef = useRef(false)
  const postToolAssistantId = useRef<string | null>(null)
  // 跟踪当前正在执行的工具消息，用于 tool_end 时兜底更新
  const lastToolMsgId = useRef<string | null>(null)
  // 审批倒计时 ticker
  const [now, setNow] = useState(Date.now())
  // 用户主动交互（展开/收起/审批）时不自动滚动到底部
  const skipScrollRef = useRef(false)

  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false
      return
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streaming])

  // 审批倒计时：有未处理的审批时每秒刷新
  useEffect(() => {
    const hasActiveApprovals = messages.some(
      (m) => m.role === 'approval' && m.createdAt && !m.resolved
    )
    if (!hasActiveApprovals) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [messages])

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages((prev) => [...prev, { ...msg, id, timestamp: Date.now() }])
  }, [])

  const updateLastAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      // 从尾部查找最后一个 assistant 消息（工具消息可能插在中间）
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'assistant') {
          return [...prev.slice(0, i), { ...prev[i], content }, ...prev.slice(i + 1)]
        }
      }
      return prev
    })
  }, [])

  const copyText = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    } catch {
      /* ignore */
    }
  }, [])

  const toggleToolExpand = useCallback((id: string) => {
    skipScrollRef.current = true
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, expanded: !m.expanded } : m)))
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

      // 重置工具跟踪状态
      hasToolsRef.current = false
      postToolAssistantId.current = null
      lastToolMsgId.current = null

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
                if (hasToolsRef.current) {
                  // 工具调用后的总结文本：创建/更新一个新的 assistant 气泡在工具消息后面
                  if (postToolAssistantId.current) {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === postToolAssistantId.current
                          ? { ...m, content: m.content + event.content }
                          : m
                      )
                    )
                  } else {
                    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                    postToolAssistantId.current = id
                    setMessages((prev) => [
                      ...prev,
                      { role: 'assistant', content: event.content, id, timestamp: Date.now() },
                    ])
                  }
                } else {
                  // 工具调用前的文本：累积到当前 assistant 气泡
                  currentAssistant += event.content
                  updateLastAssistant(currentAssistant)
                }
                setStreaming(event.content)
                break
              case 'tool_start':
                hasToolsRef.current = true
                // 新一轮工具调用：重置 post-tool 气泡，使后续文本创建新气泡（紧随新工具之后）
                postToolAssistantId.current = null
                {
                  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                  lastToolMsgId.current = id
                  setMessages((prev) => [
                    ...prev,
                    {
                      role: 'tool' as const,
                      content: `调用工具: ${event.toolName}`,
                      toolName: event.toolName,
                      toolArgs: event.content,
                      toolCallId: event.toolCallId,
                      toolStatus: 'running' as const,
                      id,
                      timestamp: Date.now(),
                    },
                  ])
                }
                break
              case 'tool_end':
                setMessages((prev) => {
                  // 优先按 toolCallId 精确匹配（支持多工具并行执行）
                  if (event.toolCallId) {
                    const target = prev.find((m) => m.toolCallId === event.toolCallId)
                    if (target) {
                      return prev.map((m) =>
                        m.id === target.id
                          ? {
                              ...m,
                              toolOutput: event.toolOutput,
                              toolStatus: 'done' as const,
                              content: event.toolOutput?.slice(0, 200) || '',
                            }
                          : m
                      )
                    }
                  }
                  // 兜底：按最近一次 tool_start 匹配
                  if (lastToolMsgId.current) {
                    return prev.map((m) =>
                      m.id === lastToolMsgId.current
                        ? {
                            ...m,
                            toolOutput: event.toolOutput,
                            toolStatus: 'done' as const,
                            content: event.toolOutput?.slice(0, 200) || '',
                          }
                        : m
                    )
                  }
                  return prev
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
              createdAt: Date.now(),
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
        skipScrollRef.current = true
        setMessages((prev) =>
          prev.map((m) =>
            m.approvalId === id ? { ...m, resolved: 'approved' as const } : m
          )
        )
      } catch {
        /* ignore */
      }
    })

    es.addEventListener('rejected', (e) => {
      try {
        const { id } = JSON.parse(e.data)
        skipScrollRef.current = true
        setMessages((prev) => {
          // 审批卡片标记为已拒绝
          let updated = prev.map((m) =>
            m.approvalId === id ? { ...m, resolved: 'rejected' as const } : m
          )
          // 兜底：如果对应工具仍处于"执行中"（tool_end 未到达），标记为失败
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'tool' && updated[i].toolStatus === 'running') {
              updated = updated.map((m, idx) =>
                idx === i ? { ...m, toolStatus: 'failed' as const } : m
              )
              break
            }
          }
          return updated
        })
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
          <div key={msg.id} className="flex items-start gap-2 group">
            <div className="bg-muted rounded-full p-1 shrink-0">
              <Bot className="size-3.5" />
            </div>
            <div className="bg-muted rounded-lg px-3 py-2 text-sm max-w-[85%] min-w-0">
              {msg.content ? (
                <MarkdownContent content={msg.content} />
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  思考中...
                </span>
              )}
              {msg.content && (
                <div className="flex justify-end">
                  <button
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted-foreground/10 text-muted-foreground"
                    onClick={() => copyText(msg.id, msg.content)}
                    title="复制内容"
                  >
                    {copiedId === msg.id ? (
                      <Check className="size-3 text-green-600" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )

      case 'tool': {
        const isRunning = msg.toolStatus === 'running'
        const isFailed = msg.toolStatus === 'failed'
        const iconBg = isRunning
          ? 'bg-blue-100 dark:bg-blue-900/30'
          : isFailed
            ? 'bg-red-100 dark:bg-red-900/30'
            : 'bg-amber-100 dark:bg-amber-900/30'
        const cardStyle = isRunning
          ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800'
          : isFailed
            ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
            : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
        const textColor = isRunning
          ? 'text-blue-700 dark:text-blue-400'
          : isFailed
            ? 'text-red-700 dark:text-red-400'
            : 'text-amber-700 dark:text-amber-400'
        return (
          <div key={msg.id} className="flex items-start gap-2">
            <div className={`${iconBg} rounded-full p-1 shrink-0`}>
              {isRunning ? (
                <Loader2 className="size-3.5 text-blue-600 animate-spin" />
              ) : isFailed ? (
                <X className="size-3.5 text-red-600" />
              ) : (
                <Check className="size-3.5 text-green-600" />
              )}
            </div>
            <div className={`${cardStyle} border rounded-lg px-3 py-1.5 text-xs max-w-[85%] min-w-0`}>
              <button
                className={`flex items-center gap-1.5 font-medium w-full text-left ${textColor}`}
                onClick={() => toggleToolExpand(msg.id)}
              >
                {msg.expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                <Wrench className="size-3" />
                <span>{msg.toolName}</span>
                {isRunning && (
                  <span className="text-[10px] opacity-70 ml-1">执行中...</span>
                )}
                {isFailed && (
                  <span className="text-[10px] opacity-70 ml-1">已拒绝/失败</span>
                )}
              </button>
              {msg.expanded && (
                <div className="mt-1.5 space-y-1.5">
                  {/* 入参 */}
                  <div>
                    <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
                      📥 入参
                    </div>
                    <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap overflow-x-auto max-h-20 bg-black/5 dark:bg-white/5 rounded p-1.5">
                      {msg.toolArgs || '(无)'}
                    </pre>
                  </div>
                  {/* 输出 */}
                  {msg.toolOutput != null && (
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
                        📤 输出
                      </div>
                      <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap overflow-x-auto max-h-24 bg-black/5 dark:bg-white/5 rounded p-1.5">
                        {msg.toolOutput || '(空)'}
                      </pre>
                    </div>
                  )}
                  {isRunning && (
                    <div className="flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400">
                      <Loader2 className="size-2.5 animate-spin" />
                      等待执行结果...
                    </div>
                  )}
                  {isFailed && (
                    <div className="flex items-center gap-1 text-[10px] text-red-600 dark:text-red-400">
                      <X className="size-2.5" />
                      命令未执行（审批被拒绝或执行失败）
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      }

      case 'approval': {
        const isResolved = msg.resolved != null
        const isApproved = msg.resolved === 'approved'
        const isRejected = msg.resolved === 'rejected'
        const elapsed = msg.createdAt && !isResolved
          ? Math.floor((now - msg.createdAt) / 1000)
          : 0
        const remaining = !isResolved ? Math.max(0, 30 - elapsed) : 0
        const isUrgent = remaining <= 10 && remaining > 0

        // 根据状态选择颜色
        const colorSet = isApproved
          ? {
              iconBg: 'bg-green-100 dark:bg-green-900/30',
              iconColor: 'text-green-600',
              cardBg: 'bg-green-50 dark:bg-green-950/20',
              cardBorder: 'border-green-200 dark:border-green-800',
              titleColor: 'text-green-700 dark:text-green-400',
              codeBg: 'bg-green-100 dark:bg-green-900/40',
            }
          : isRejected
            ? {
                iconBg: 'bg-gray-100 dark:bg-gray-800/50',
                iconColor: 'text-gray-500',
                cardBg: 'bg-gray-50 dark:bg-gray-900/30',
                cardBorder: 'border-gray-200 dark:border-gray-700',
                titleColor: 'text-gray-600 dark:text-gray-400',
                codeBg: 'bg-gray-100 dark:bg-gray-800/40',
              }
            : {
                iconBg: 'bg-red-100 dark:bg-red-900/30',
                iconColor: 'text-red-600',
                cardBg: 'bg-red-50 dark:bg-red-950/20',
                cardBorder: 'border-red-200 dark:border-red-800',
                titleColor: 'text-red-700 dark:text-red-400',
                codeBg: 'bg-red-100 dark:bg-red-900/40',
              }

        return (
          <div key={msg.id} className="flex items-start gap-2">
            <div className={`${colorSet.iconBg} rounded-full p-1 shrink-0`}>
              {isApproved ? (
                <ShieldCheck className={`size-3.5 ${colorSet.iconColor}`} />
              ) : (
                <ShieldAlert className={`size-3.5 ${colorSet.iconColor}`} />
              )}
            </div>
            <div className={`${colorSet.cardBg} ${colorSet.cardBorder} border rounded-lg px-3 py-2 text-xs max-w-[85%] w-full`}>
              <div className={`flex items-center gap-1.5 font-medium ${colorSet.titleColor} mb-1.5`}>
                {isApproved ? (
                  <ShieldCheck className="size-3.5" />
                ) : (
                  <ShieldAlert className="size-3.5" />
                )}
                {isResolved
                  ? isApproved
                    ? '已批准执行'
                    : '已拒绝执行'
                  : '危险操作需要审批'}
              </div>
              <code className={`block ${colorSet.codeBg} rounded px-2 py-1 text-[11px] mb-2 font-mono break-all whitespace-pre-wrap`}>
                {msg.command}
              </code>
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className={`text-[10px] ${isApproved ? 'text-green-600' : isRejected ? 'text-gray-500' : 'text-red-600'}`}>
                  {msg.risk === 'dangerous' ? '不可逆操作' : '需确认'}
                </Badge>
                {isResolved ? (
                  <span className={`text-[10px] font-medium ${isApproved ? 'text-green-600' : 'text-gray-500'}`}>
                    {isApproved ? '已批准' : '已拒绝'}
                  </span>
                ) : (
                  <span
                    className={`text-[10px] flex items-center gap-0.5 font-mono ${
                      isUrgent ? 'text-red-600 font-medium' : 'text-muted-foreground'
                    }`}
                  >
                    <Clock className={`size-2.5 ${isUrgent ? 'animate-pulse' : ''}`} />
                    {remaining > 0 ? `${remaining}s 后自动拒绝` : '已超时'}
                  </span>
                )}
                <div className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant={isRejected ? 'default' : 'outline'}
                    className={`h-6 text-[10px] ${
                      isRejected
                        ? 'bg-red-600 hover:bg-red-600 cursor-default'
                        : isResolved
                          ? 'text-muted-foreground border-muted cursor-default'
                          : 'text-red-600 hover:bg-red-50'
                    }`}
                    onClick={() => !isResolved && msg.approvalId && handleReject(msg.approvalId)}
                    disabled={isResolved}
                  >
                    <X className="size-3" />
                    {isRejected ? '已拒绝' : '拒绝'}
                  </Button>
                  <Button
                    size="sm"
                    className={`h-6 text-[10px] ${
                      isApproved
                        ? 'bg-green-600 hover:bg-green-600 cursor-default'
                        : isResolved
                          ? 'bg-muted text-muted-foreground cursor-default'
                          : 'bg-green-600 hover:bg-green-700'
                    }`}
                    onClick={() => !isResolved && msg.approvalId && handleApprove(msg.approvalId)}
                    disabled={isResolved}
                  >
                    <Check className="size-3" />
                    {isApproved ? '已批准' : '批准'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )
      }

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
