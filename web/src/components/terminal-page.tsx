import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { type HostItem } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plug, Unplug, Bot } from 'lucide-react'
import { AiChatPanel } from '@/components/ai-chat-panel'

export function TerminalPage({ hosts }: { hosts: HostItem[] }) {
  const [host, setHost] = useState('')
  const [connected, setConnected] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!host && hosts.length > 0) setHost(hosts[0].name)
  }, [hosts, host])

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#ffffff',
        foreground: '#27272a',
        cursor: '#18181b',
        cursorAccent: '#ffffff',
        selectionBackground: '#dbeafe',
        black: '#3f3f46',
        red: '#dc2626',
        green: '#16a34a',
        yellow: '#ca8a04',
        blue: '#2563eb',
        magenta: '#9333ea',
        cyan: '#0891b2',
        white: '#e4e4e7',
        brightBlack: '#71717a',
        brightRed: '#ef4444',
        brightGreen: '#22c55e',
        brightYellow: '#eab308',
        brightBlue: '#3b82f6',
        brightMagenta: '#a855f7',
        brightCyan: '#06b6d4',
        brightWhite: '#fafafa',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (boxRef.current) {
      term.open(boxRef.current)
      fit.fit()
    }
    term.writeln('选择主机后点击「连接」开始会话。')
    term.writeln('点击「AI 助手」可使用 AI 辅助巡检和诊断。')
    termRef.current = term
    fitRef.current = fit

    const onResize = () => {
      fit.fit()
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      wsRef.current?.close()
      term.dispose()
    }
  }, [])

  const disconnect = () => {
    wsRef.current?.close()
    wsRef.current = null
    setConnected(false)
  }

  const connect = () => {
    if (!host) return
    disconnect()
    const term = termRef.current!
    term.reset()
    term.writeln(`正在连接 ${host} …`)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/term/${encodeURIComponent(host)}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      fitRef.current?.fit()
      ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }))
      term.focus()
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') term.write(ev.data)
      else term.write(new Uint8Array(ev.data))
    }
    ws.onclose = () => {
      setConnected(false)
      term.writeln('\r\n\x1b[33m[连接已断开]\x1b[0m')
    }
    ws.onerror = () => term.writeln('\r\n\x1b[31m[连接出错]\x1b[0m')

    const sub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d)
    })
    ws.addEventListener('close', () => sub.dispose())
  }

  // AI 命令事件流 — 在终端中同步展示 AI 执行的命令
  useEffect(() => {
    const es = new EventSource('/api/ai/commands-stream')

    es.addEventListener('exec', (e) => {
      try {
        const { host: evHost, command } = JSON.parse(e.data)
        if (evHost === host && termRef.current) {
          termRef.current.writeln(`\r\n\x1b[36m[AI 执行]\x1b[0m ${command}`)
        }
      } catch { /* ignore */ }
    })

    es.addEventListener('result', (e) => {
      try {
        const { host: evHost, exit_code, stdout, stderr } = JSON.parse(e.data)
        if (evHost === host && termRef.current) {
          const term = termRef.current
          // 显示完整 stdout
          if (stdout) {
            const lines = stdout.split('\n')
            for (const line of lines) {
              term.writeln(`  \x1b[90m│\x1b[0m ${line}`)
            }
          }
          if (stderr && stderr.length > 0) {
            term.writeln(`  \x1b[31mstderr:\x1b[0m`)
            const lines = stderr.split('\n')
            for (const line of lines) {
              term.writeln(`  \x1b[31m│\x1b[0m ${line}`)
            }
          }
          const status = exit_code === 0
            ? '\x1b[32m✓ 成功\x1b[0m'
            : `\x1b[31m✗ 失败 (exit ${exit_code})\x1b[0m`
          const info = stdout || stderr
            ? `stdout: ${stdout?.length || 0}B  stderr: ${stderr?.length || 0}B`
            : ''
          term.writeln(`  ${status}${info ? '  ' + info : ''}`)
        }
      } catch { /* ignore */ }
    })

    return () => es.close()
  }, [host])

  return (
    <div className="flex h-full flex-col gap-4 p-4 lg:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">终端</h2>
          <p className="text-muted-foreground text-sm">
            {connected
              ? '已连接 — 可直接执行远程命令'
              : '连接后可直接执行远程命令（如重启服务）'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connected && (
            <Badge variant="outline" className="text-green-600">
              已连接 {host}
            </Badge>
          )}
          <Select value={host} onValueChange={setHost} disabled={connected}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="选择主机" />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={h.name} value={h.name}>
                  {h.name}（{h.user}@{h.host}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {connected ? (
            <Button variant="outline" onClick={disconnect}>
              <Unplug /> 断开
            </Button>
          ) : (
            <Button onClick={connect} disabled={!host}>
              <Plug /> 连接
            </Button>
          )}
          <Button
            variant={aiOpen ? 'default' : 'outline'}
            size="icon"
            className="size-9"
            onClick={() => setAiOpen(!aiOpen)}
            title="AI 助手"
          >
            <Bot className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 flex gap-3 overflow-hidden">
        {/* 终端 */}
        <div
          className={`min-h-0 flex-1 overflow-hidden rounded-lg border bg-white p-2 ${
            aiOpen ? '' : 'w-full'
          }`}
        >
          <div ref={boxRef} className="h-full w-full" />
        </div>
        {/* AI 面板 */}
        {aiOpen && (
          <div className="w-96 shrink-0 overflow-hidden rounded-lg border bg-background">
            <AiChatPanel host={host} />
          </div>
        )}
      </div>
    </div>
  )
}
