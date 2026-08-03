import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type HostItem, type SaveHostReq, type HostImportItem } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Plus, Plug, Trash2, Pencil, Download, Upload } from 'lucide-react'

const emptyForm: SaveHostReq = { name: '', host: '', port: 22, user: '' }

export function HostsPage({ onHostsChanged }: { onHostsChanged?: () => void }) {
  const [hosts, setHosts] = useState<HostItem[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<SaveHostReq>(emptyForm)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importDup, setImportDup] = useState<'skip' | 'overwrite'>('skip')

  const refresh = () => {
    api
      .hosts()
      .then(setHosts)
      .catch((e) => toast.error(String(e.message)))
      .finally(() => setLoading(false))
  }
  useEffect(refresh, [])

  const startAdd = () => {
    setForm(emptyForm)
    setEditing(false)
    setOpen(true)
  }

  const startEdit = (h: HostItem) => {
    setForm({
      name: h.name,
      host: h.host,
      port: h.port,
      user: h.user,
      remote_root: h.remote_root ?? '',
      note: h.note ?? '',
    })
    setEditing(true)
    setOpen(true)
  }

  const save = async () => {
    if (!form.name || !form.host || !form.user) {
      toast.error('名称、地址、用户名为必填项')
      return
    }
    setSaving(true)
    try {
      await api.saveHost(form)
      toast.success(`主机 ${form.name} 已保存`)
      setOpen(false)
      refresh()
      onHostsChanged?.()
    } catch (e) {
      toast.error(String((e as Error).message))
    } finally {
      setSaving(false)
    }
  }

  const test = async (name: string) => {
    setTesting(name)
    try {
      await api.testHost(name)
      toast.success(`${name} 连接成功`)
    } catch (e) {
      toast.error(`${name} 连接失败: ${(e as Error).message}`)
    } finally {
      setTesting(null)
    }
  }

  const doDelete = async () => {
    if (!deleting) return
    try {
      await api.deleteHost(deleting)
      toast.success(`主机 ${deleting} 已删除`)
      refresh()
      onHostsChanged?.()
    } catch (e) {
      toast.error(String((e as Error).message))
    } finally {
      setDeleting(null)
    }
  }

  const handleExport = async () => {
    try {
      const data = await api.exportHosts()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sup-hosts-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`已导出 ${data.hosts.length} 个主机`)
    } catch (e) {
      toast.error(`导出失败: ${(e as Error).message}`)
    }
  }

  const handleImport = async () => {
    let hosts: HostImportItem[]
    try {
      hosts = JSON.parse(importText)
      if (!hosts || !Array.isArray(hosts)) {
        // 尝试解析 {version, hosts} 格式
        const wrapper = JSON.parse(importText) as { version?: number; hosts?: HostImportItem[] }
        if (wrapper.hosts && Array.isArray(wrapper.hosts)) {
          hosts = wrapper.hosts
        } else {
          throw new Error('无效的 JSON 格式')
        }
      }
    } catch {
      toast.error('JSON 解析失败，请检查格式')
      return
    }

    setImporting(true)
    try {
      const result = await api.importHosts(hosts, importDup)
      toast.success(
        `导入完成：新增 ${result.imported}，跳过 ${result.skipped}，覆盖 ${result.overwritten}`
      )
      setImportOpen(false)
      setImportText('')
      refresh()
      onHostsChanged?.()
    } catch (e) {
      toast.error(`导入失败: ${(e as Error).message}`)
    } finally {
      setImporting(false)
    }
  }

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImportText(reader.result as string)
    reader.readAsText(file)
    // 重置 input 以便重复选择同一文件
    e.target.value = ''
  }

  const set = (k: keyof SaveHostReq, v: string | number) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">主机</h2>
          <p className="text-muted-foreground text-sm">预配置的服务器连接</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download /> 导出
          </Button>
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Upload /> 导入
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>导入主机</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label>选择 JSON 文件或粘贴内容</Label>
                  <Input type="file" accept=".json" onChange={handleFilePick} />
                </div>
                <div className="grid gap-1.5">
                  <Label>JSON 内容（从上一步导出，不含密码）</Label>
                  <Textarea
                    value={importText}
                    rows={8}
                    className="font-mono text-xs"
                    placeholder={`[
  {"name":"prod-web","host":"10.0.0.1","port":22,"user":"root"}
]`}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>重复主机处理</Label>
                  <Select
                    value={importDup}
                    onValueChange={(v) => setImportDup(v as 'skip' | 'overwrite')}
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">跳过已有</SelectItem>
                      <SelectItem value="overwrite">覆盖已有</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setImportOpen(false)}>
                  取消
                </Button>
                <Button onClick={handleImport} disabled={importing || !importText.trim()}>
                  {importing ? '导入中…' : '导入'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={startAdd}>
              <Plus /> 添加主机
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{editing ? `编辑主机 ${form.name}` : '添加主机'}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>名称 *</Label>
                  <Input
                    value={form.name}
                    disabled={editing}
                    placeholder="prod-web"
                    onChange={(e) => set('name', e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>用户名 *</Label>
                  <Input
                    value={form.user}
                    placeholder="root"
                    onChange={(e) => set('user', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 grid gap-1.5">
                  <Label>地址 *</Label>
                  <Input
                    value={form.host}
                    placeholder="10.0.0.1"
                    onChange={(e) => set('host', e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>端口</Label>
                  <Input
                    type="number"
                    value={form.port}
                    onChange={(e) => set('port', Number(e.target.value) || 22)}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>密码（留空则不修改）</Label>
                <Input
                  type="password"
                  value={form.password ?? ''}
                  onChange={(e) => set('password', e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>私钥路径（可选）</Label>
                  <Input
                    value={form.key_path ?? ''}
                    placeholder="~/.ssh/id_rsa"
                    onChange={(e) => set('key_path', e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>私钥口令（可选）</Label>
                  <Input
                    type="password"
                    value={form.passphrase ?? ''}
                    onChange={(e) => set('passphrase', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>远程根目录（可选）</Label>
                <Input
                  value={form.remote_root ?? ''}
                  placeholder="/var/www/app"
                  onChange={(e) => set('remote_root', e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>备注</Label>
                <Textarea
                  value={form.note ?? ''}
                  rows={2}
                  onChange={(e) => set('note', e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>地址</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>认证</TableHead>
              <TableHead>远程根目录</TableHead>
              <TableHead>备注</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hosts.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground h-24 text-center">
                  {loading ? '加载中…' : '暂无主机，点击右上角添加'}
                </TableCell>
              </TableRow>
            )}
            {hosts.map((h) => (
              <TableRow key={h.name}>
                <TableCell className="font-medium">{h.name}</TableCell>
                <TableCell>
                  {h.host}:{h.port}
                </TableCell>
                <TableCell>{h.user}</TableCell>
                <TableCell>
                  <Badge variant="outline">{h.auth === 'key' ? '密钥' : '密码'}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground max-w-48 truncate font-mono text-xs">
                  {h.remote_root || '-'}
                </TableCell>
                <TableCell className="text-muted-foreground max-w-40 truncate">
                  {h.note || '-'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={testing === h.name}
                      onClick={() => test(h.name)}
                    >
                      <Plug />
                      {testing === h.name ? '测试中…' : '测试'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => startEdit(h)}>
                      <Pencil /> 编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeleting(h.name)}
                    >
                      <Trash2 /> 删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除主机 {deleting}？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除该主机配置及钥匙串中保存的凭据，此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
