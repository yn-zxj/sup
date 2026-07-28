import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  api,
  fmtSize,
  type HostItem,
  type MapRow,
  type Preset,
  type RunStatus,
  type ValidateResp,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Plus, X, CircleCheck, CircleX, Upload, ClipboardPaste, Bookmark, BookmarkPlus } from 'lucide-react'

function parseBatch(text: string): MapRow[] {
  const rows: MapRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.includes('->') ? '->' : line.includes('→') ? '→' : null
    if (sep) {
      const i = line.indexOf(sep)
      rows.push({ local: line.slice(0, i).trim(), remote: line.slice(i + sep.length).trim() })
      continue
    }
    const i = line.indexOf(':')
    if (i > 0) {
      rows.push({ local: line.slice(0, i).trim(), remote: line.slice(i + 1).trim() })
    } else {
      rows.push({ local: line, remote: '' })
    }
  }
  return rows
}

type Phase = 'edit' | 'validated' | 'running' | 'done'

export function UploadPage({ hosts }: { hosts: HostItem[] }) {
  const [host, setHost] = useState('')
  const [maps, setMaps] = useState<MapRow[]>([{ local: '', remote: '' }])
  const [phase, setPhase] = useState<Phase>('edit')
  const [validated, setValidated] = useState<ValidateResp | null>(null)
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshPresets = () => {
    api.presets().then(setPresets).catch(() => {})
  }
  useEffect(refreshPresets, [])

  useEffect(() => {
    if (!host && hosts.length > 0) setHost(hosts[0].name)
  }, [hosts, host])

  useEffect(() => () => stopPoll(), [])

  const stopPoll = () => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }

  const setMap = (i: number, k: keyof MapRow, v: string) =>
    setMaps((ms) => ms.map((m, j) => (j === i ? { ...m, [k]: v } : m)))

  const filledMaps = () => maps.filter((m) => m.local.trim())

  const validate = async () => {
    if (!host) return toast.error('请选择主机')
    const ms = filledMaps()
    if (ms.length === 0) return toast.error('请至少填写一条上传映射')
    setBusy(true)
    try {
      const r = await api.validate(host, ms)
      setValidated(r)
      setPhase('validated')
      if (r.missing.length > 0)
        toast.warning(`${r.missing.length} 个文件不存在，将被剔除`)
      else toast.success(`校验通过，共 ${r.entries.length} 个文件`)
    } catch (e) {
      toast.error(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    setBusy(true)
    try {
      const { run_id } = await api.runPush(host, filledMaps())
      setPhase('running')
      setStatus(null)
      timer.current = setInterval(async () => {
        try {
          const s = await api.pushStatus(run_id)
          setStatus(s)
          if (s.finished) {
            stopPoll()
            setPhase('done')
            if (s.error) toast.error(`上传出错: ${s.error}`)
            else if (s.failed > 0) toast.error(`完成：${s.ok} 成功 / ${s.failed} 失败`)
            else toast.success(`全部 ${s.ok} 个文件上传成功`)
          }
        } catch {
          /* poll again */
        }
      }, 500)
    } catch (e) {
      toast.error(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const applyBatch = () => {
    const parsed = parseBatch(batchText)
    if (parsed.length === 0) {
      toast.error('未解析到任何路径')
      return
    }
    setMaps((ms) => [...ms.filter((m) => m.local.trim()), ...parsed])
    setBatchOpen(false)
    setBatchText('')
    toast.success(`已解析 ${parsed.length} 条映射`)
  }

  const applyPreset = (p: Preset) => {
    setHost(p.host)
    setMaps(p.maps.length > 0 ? p.maps.map((m) => ({ ...m })) : [{ local: '', remote: '' }])
    setPresetName(p.name)
    reset()
    toast.success(`已套用预设「${p.name}」`)
  }

  const savePreset = async () => {
    const name = presetName.trim()
    if (!name) return toast.error('请输入预设名称')
    if (!host) return toast.error('请选择主机')
    const ms = filledMaps()
    if (ms.length === 0) return toast.error('请至少填写一条上传映射')
    try {
      await api.savePreset({ name, host, maps: ms })
      toast.success(`预设「${name}」已保存`)
      setPresetOpen(false)
      refreshPresets()
    } catch (e) {
      toast.error(String((e as Error).message))
    }
  }

  const deletePreset = async (name: string) => {
    try {
      await api.deletePreset(name)
      toast.success(`预设「${name}」已删除`)
      refreshPresets()
    } catch (e) {
      toast.error(String((e as Error).message))
    }
  }

  const reset = () => {
    stopPoll()
    setPhase('edit')
    setValidated(null)
    setStatus(null)
  }

  const pct =
    status && status.bytes_total > 0
      ? Math.min(100, Math.round((status.bytes_done / status.bytes_total) * 100))
      : status && status.total > 0
        ? Math.round((status.done / status.total) * 100)
        : 0

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <div>
        <h2 className="text-lg font-semibold">上传</h2>
        <p className="text-muted-foreground text-sm">校验本地文件后按映射上传到远程主机</p>
      </div>

      {presets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bookmark className="size-4" /> 上传预设
            </CardTitle>
            <CardDescription>点击套用；套用后修改再保存同名即为编辑</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <div
                  key={p.name}
                  className="group hover:bg-accent flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-sm transition-colors"
                >
                  <button
                    className="flex cursor-pointer items-center gap-2"
                    disabled={phase === 'running'}
                    onClick={() => applyPreset(p)}
                    title={p.maps.map((m) => `${m.local} → ${m.remote || '(根目录拼接)'}`).join('\n')}
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {p.host} · {p.maps.length} 条
                    </span>
                  </button>
                  <button
                    className="text-muted-foreground hover:text-destructive ml-1 cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
                    disabled={phase === 'running'}
                    onClick={() => deletePreset(p.name)}
                    title="删除预设"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>上传映射</CardTitle>
          <CardDescription>
            本地路径 → 远程路径。远程以 / 开头为绝对路径；相对路径或留空时拼接到主机的远程根目录下；远程为已存在目录时自动上传到该目录内；目录会递归上传。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid max-w-xs gap-1.5">
            <Label>目标主机</Label>
            <Select value={host} onValueChange={setHost} disabled={phase === 'running'}>
              <SelectTrigger>
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
          </div>

          <div className="flex flex-col gap-2">
            {maps.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="font-mono text-xs"
                  placeholder="/本地/路径/dist/app.js"
                  value={m.local}
                  disabled={phase === 'running'}
                  onChange={(e) => setMap(i, 'local', e.target.value)}
                />
                <span className="text-muted-foreground shrink-0">→</span>
                <Input
                  className="font-mono text-xs"
                  placeholder="/远程/路径（可留空）"
                  value={m.remote}
                  disabled={phase === 'running'}
                  onChange={(e) => setMap(i, 'remote', e.target.value)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={maps.length === 1 || phase === 'running'}
                  onClick={() => setMaps((ms) => ms.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={phase === 'running'}
                onClick={() => setMaps((ms) => [...ms, { local: '', remote: '' }])}
              >
                <Plus /> 添加一行
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={phase === 'running'}
                onClick={() => setBatchOpen(true)}
              >
                <ClipboardPaste /> 批量输入
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={phase === 'running'}
                onClick={() => setPresetOpen(true)}
              >
                <BookmarkPlus /> 保存为预设
              </Button>
            </div>
          </div>

          <div className="flex gap-2">
            {phase === 'edit' && (
              <Button onClick={validate} disabled={busy}>
                {busy ? '校验中…' : '校验文件'}
              </Button>
            )}
            {phase === 'validated' && validated && (
              <>
                <Button onClick={run} disabled={busy || validated.entries.length === 0}>
                  <Upload />
                  {validated.missing.length > 0
                    ? `剔除缺失并上传 ${validated.entries.length} 个文件`
                    : `开始上传 ${validated.entries.length} 个文件`}
                </Button>
                <Button variant="outline" onClick={reset}>
                  返回修改
                </Button>
              </>
            )}
            {phase === 'done' && (
              <Button variant="outline" onClick={reset}>
                再次上传
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>保存为预设</DialogTitle>
            <DialogDescription>
              将当前主机（{host || '未选择'}）与 {filledMaps().length}
              条映射保存为预设。名称相同时覆盖旧预设。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>预设名称</Label>
            <Input
              value={presetName}
              placeholder="例如：订单服务 jar 包"
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && savePreset()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPresetOpen(false)}>
              取消
            </Button>
            <Button onClick={savePreset}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>批量输入映射</DialogTitle>
            <DialogDescription>
              每行一条，支持三种格式：<code>本地:远程</code>、<code>本地 -&gt; 远程</code>
              、或仅 <code>本地路径</code>（远程按主机根目录拼接）。# 开头的行忽略。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-56 font-mono text-xs"
            placeholder={`dist/app.js:/var/www/app/dist/app.js\ndist/main.css -> /var/www/app/dist/main.css\nsrc/logo.png\n# 注释行会被忽略`}
            value={batchText}
            onChange={(e) => setBatchText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button onClick={applyBatch}>解析填入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {phase === 'validated' && validated && (
        <Card>
          <CardHeader>
            <CardTitle>校验结果</CardTitle>
            <CardDescription>
              {validated.entries.length} 个文件待上传
              {validated.missing.length > 0 && `，${validated.missing.length} 个缺失`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {validated.missing.length > 0 && (
              <div className="border-destructive/50 bg-destructive/5 mb-4 rounded-lg border p-3">
                <p className="text-destructive mb-2 text-sm font-medium">以下文件不存在，将被剔除：</p>
                <ul className="flex flex-col gap-1">
                  {validated.missing.map((m) => (
                    <li key={m} className="text-destructive font-mono text-xs">
                      ✗ {m}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="max-h-80 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>本地</TableHead>
                    <TableHead>远程</TableHead>
                    <TableHead className="text-right">大小</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {validated.entries.map((e) => (
                    <TableRow key={e.local + e.remote}>
                      <TableCell className="font-mono text-xs">{e.local}</TableCell>
                      <TableCell className="font-mono text-xs">{e.remote}</TableCell>
                      <TableCell className="text-right text-xs">{fmtSize(e.size)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {(phase === 'running' || phase === 'done') && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {phase === 'running' ? (
                '上传中…'
              ) : status?.failed || status?.error ? (
                <>
                  <CircleX className="text-destructive size-5" /> 上传完成（有失败）
                </>
              ) : (
                <>
                  <CircleCheck className="size-5 text-green-600" /> 上传完成
                </>
              )}
            </CardTitle>
            {status && (
              <CardDescription>
                {status.done}/{status.total} 个文件 · {fmtSize(status.bytes_done)}/
                {fmtSize(status.bytes_total)}
                {status.task_id != null && ` · 任务 #${status.task_id}`}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Progress value={pct} />
            {phase === 'running' && status?.current && (
              <p className="text-muted-foreground truncate font-mono text-xs">{status.current}</p>
            )}
            {status && (
              <div className="flex gap-2">
                <Badge variant="outline" className="text-green-600">
                  成功 {status.ok}
                </Badge>
                <Badge variant="outline" className={status.failed ? 'text-destructive' : ''}>
                  失败 {status.failed}
                </Badge>
              </div>
            )}
            {status?.error && <p className="text-destructive text-sm">{status.error}</p>}
            {status && status.failures.length > 0 && (
              <ul className="flex flex-col gap-1">
                {status.failures.map((f, i) => (
                  <li key={i} className="text-destructive font-mono text-xs">
                    ✗ {f.local}: {f.error}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
