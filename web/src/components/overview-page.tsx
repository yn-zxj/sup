import { useEffect, useState } from 'react'
import { api, type HostItem, type TaskRow } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function OverviewPage({
  hosts,
  onNavigate,
}: {
  hosts: HostItem[]
  onNavigate: (page: string) => void
}) {
  const [tasks, setTasks] = useState<TaskRow[]>([])

  useEffect(() => {
    api.logs({ limit: 100 }).then(setTasks).catch(() => {})
  }, [])

  const totalFiles = tasks.reduce((s, t) => s + t.total, 0)
  const okFiles = tasks.reduce((s, t) => s + t.ok, 0)
  const rate = totalFiles > 0 ? `${((okFiles / totalFiles) * 100).toFixed(1)}%` : '-'

  const stats = [
    { label: '主机数', value: String(hosts.length), desc: '已配置的服务器', page: 'hosts' },
    { label: '上传任务', value: String(tasks.length), desc: '最近 100 条记录', page: 'logs' },
    { label: '上传文件', value: String(totalFiles), desc: `成功 ${okFiles} 个`, page: 'logs' },
    { label: '成功率', value: rate, desc: '按文件计', page: 'logs' },
  ]

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <div>
        <h2 className="text-lg font-semibold">概览</h2>
        <p className="text-muted-foreground text-sm">sup — 轻量增量部署工具</p>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Card
            key={s.label}
            className="cursor-pointer transition-shadow hover:shadow-md"
            onClick={() => onNavigate(s.page)}
          >
            <CardHeader>
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{s.value}</CardTitle>
              <p className="text-muted-foreground text-xs">{s.desc}</p>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>最近上传</CardTitle>
          <CardDescription>最新 10 条任务，点击「日志」查看全部</CardDescription>
        </CardHeader>
        <div className="px-6 pb-6">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>主机</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead className="text-right">文件数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground h-20 text-center">
                      暂无上传记录
                    </TableCell>
                  </TableRow>
                )}
                {tasks.slice(0, 10).map((t) => (
                  <TableRow key={t.id} className="cursor-pointer" onClick={() => onNavigate('logs')}>
                    <TableCell>#{t.id}</TableCell>
                    <TableCell>{t.host}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{t.started_at}</TableCell>
                    <TableCell>
                      {t.failed > 0 ? (
                        <Badge variant="destructive">失败 {t.failed}</Badge>
                      ) : (
                        <Badge variant="outline" className="text-green-600">
                          成功
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{t.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </Card>
    </div>
  )
}
