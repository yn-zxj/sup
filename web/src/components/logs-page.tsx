import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, fmtSize, type FileRow, type HostItem, type TaskRow } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { RefreshCw } from 'lucide-react'

const ALL = '__all__'

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ResultBadge({ task }: { task: TaskRow }) {
  if (task.failed > 0) return <Badge variant="destructive">失败 {task.failed}</Badge>
  if (task.skipped > 0) return <Badge variant="secondary">部分跳过</Badge>
  return (
    <Badge variant="outline" className="text-green-600">
      成功
    </Badge>
  )
}

export function LogsPage({ hosts }: { hosts: HostItem[] }) {
  const [rows, setRows] = useState<TaskRow[]>([])
  const [host, setHost] = useState(ALL)
  const [failedOnly, setFailedOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<{ task: TaskRow; files: FileRow[] } | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    api
      .logs({ host: host === ALL ? undefined : host, failed: failedOnly, limit: 100 })
      .then(setRows)
      .catch((e) => toast.error(String(e.message)))
      .finally(() => setLoading(false))
  }, [host, failedOnly])

  useEffect(refresh, [refresh])

  const openDetail = async (id: number) => {
    try {
      setDetail(await api.logDetail(id))
    } catch (e) {
      toast.error(String((e as Error).message))
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">上传日志</h2>
          <p className="text-muted-foreground text-sm">历史上传任务与文件明细</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="failed-only"
              checked={failedOnly}
              onCheckedChange={(v) => setFailedOnly(v === true)}
            />
            <Label htmlFor="failed-only">仅看失败</Label>
          </div>
          <Select value={host} onValueChange={setHost}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部主机</SelectItem>
              {hosts.map((h) => (
                <SelectItem key={h.name} value={h.name}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={refresh}>
            <RefreshCw />
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">#</TableHead>
              <TableHead>主机</TableHead>
              <TableHead>时间</TableHead>
              <TableHead>结果</TableHead>
              <TableHead className="text-right">总数</TableHead>
              <TableHead className="text-right">成功</TableHead>
              <TableHead className="text-right">失败</TableHead>
              <TableHead className="text-right">跳过</TableHead>
              <TableHead className="text-right">耗时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground h-24 text-center">
                  {loading ? '加载中…' : '暂无记录'}
                </TableCell>
              </TableRow>
            )}
            {rows.map((t) => (
              <TableRow
                key={t.id}
                className="cursor-pointer"
                onClick={() => openDetail(t.id)}
              >
                <TableCell className="font-medium">#{t.id}</TableCell>
                <TableCell>{t.host}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{t.started_at}</TableCell>
                <TableCell>
                  <ResultBadge task={t} />
                </TableCell>
                <TableCell className="text-right">{t.total}</TableCell>
                <TableCell className="text-right text-green-600">{t.ok}</TableCell>
                <TableCell className={`text-right ${t.failed ? 'text-destructive' : ''}`}>
                  {t.failed}
                </TableCell>
                <TableCell className="text-muted-foreground text-right">{t.skipped}</TableCell>
                <TableCell className="text-right text-xs">{fmtDuration(t.duration_ms)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Sheet open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <SheetContent className="w-full overflow-auto data-[side=right]:w-full data-[side=right]:sm:max-w-4xl">
          {detail && (
            <>
              <SheetHeader>
                <SheetTitle>任务 #{detail.task.id}</SheetTitle>
                <SheetDescription>
                  {detail.task.host} · {detail.task.started_at} ·{' '}
                  {fmtDuration(detail.task.duration_ms)} · 成功 {detail.task.ok} / 失败{' '}
                  {detail.task.failed} / 跳过 {detail.task.skipped}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-4">
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>文件</TableHead>
                        <TableHead className="text-right">大小</TableHead>
                        <TableHead>结果</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.files.map((f) => (
                        <TableRow key={f.id}>
                          <TableCell>
                            <div className="font-mono text-xs">{f.local}</div>
                            <div className="text-muted-foreground font-mono text-xs">
                              → {f.remote}
                            </div>
                            {f.error && (
                              <div className="text-destructive text-xs">{f.error}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs">{fmtSize(f.size)}</TableCell>
                          <TableCell>
                            {f.result === 'ok' ? (
                              <Badge variant="outline" className="text-green-600">
                                成功
                              </Badge>
                            ) : f.result === 'failed' ? (
                              <Badge variant="destructive">失败</Badge>
                            ) : (
                              <Badge variant="secondary">跳过</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
