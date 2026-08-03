import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { api, type FileEntry, type HostItem, fmtSize } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  Folder,
  FolderOpen,
  FileText,
  Save,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Loader2,
} from 'lucide-react'

interface TreeNode {
  entry: FileEntry
  children: TreeNode[]
  loaded: boolean
  loading: boolean
}

function getLang(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    conf: 'ini',
    cfg: 'ini',
    ini: 'ini',
    toml: 'ini',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    xml: 'xml',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    md: 'markdown',
    log: 'plaintext',
    txt: 'plaintext',
    env: 'plaintext',
    nginx: 'nginx',
    cnf: 'ini',
  }
  return map[ext ?? ''] ?? 'plaintext'
}

export function FileEditorPage({ hosts }: { hosts: HostItem[] }) {
  const [host, setHost] = useState('')
  const [connected, setConnected] = useState(false)
  const [rootPath, setRootPath] = useState('/')
  const [tree, setTree] = useState<TreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(true)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    if (!host && hosts.length > 0) setHost(hosts[0].name)
  }, [hosts, host])

  // 点击「连接」按钮手动加载
  const handleConnect = () => {
    if (!host) return
    setTreeLoading(true)
    loadRoot().finally(() => setConnected(true))
  }

  // 断开连接
  const handleDisconnect = () => {
    setTree([])
    setConnected(false)
    setOpenFile(null)
    setFileContent('')
  }

  // 切换主机时重置
  useEffect(() => {
    if (connected) handleDisconnect()
  }, [host])

  // 加载根目录
  const loadRoot = useCallback(async () => {
    if (!host) return
    setTreeLoading(true)
    try {
      const { entries } = await api.listFiles(host, rootPath)
      setTree(
        entries.map((e) => ({
          entry: e,
          children: [],
          loaded: false,
          loading: false,
        }))
      )
    } catch (err) {
      toast.error(`加载目录失败: ${(err as Error).message}`)
      throw err
    } finally {
      setTreeLoading(false)
    }
  }, [host, rootPath])

  // 不再自动加载，而是手动点击「连接」

  // 加载子目录
  const toggleExpand = async (node: TreeNode) => {
    const path = node.entry.path
    const isExpanded = expandedPaths.has(path)

    if (isExpanded) {
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      return
    }

    setExpandedPaths((prev) => new Set(prev).add(path))

    if (!node.loaded && !node.loading) {
      setTree((prev) =>
        prev.map((n) => (n.entry.path === path ? { ...n, loading: true } : n))
      )
      try {
        const { entries } = await api.listFiles(host, path)
        setTree((prev) =>
          prev.map((n) =>
            n.entry.path === path
              ? {
                  ...n,
                  children: entries.map((e) => ({
                    entry: e,
                    children: [],
                    loaded: false,
                    loading: false,
                  })),
                  loaded: true,
                  loading: false,
                }
              : n
          )
        )
      } catch (err) {
        toast.error(`加载失败: ${(err as Error).message}`)
        setTree((prev) =>
          prev.map((n) => (n.entry.path === path ? { ...n, loading: false } : n))
        )
      }
    }
  }

  // 打开文件
  const openFileHandler = async (filePath: string) => {
    setFileLoading(true)
    setOpenFile(filePath)
    try {
      const { content } = await api.readFile(host, filePath)
      setFileContent(content)
      setOriginalContent(content)
      setSaved(true)
    } catch (err) {
      toast.error(`读取文件失败: ${(err as Error).message}`)
      setOpenFile(null)
    } finally {
      setFileLoading(false)
    }
  }

  // 保存文件
  const saveFile = async () => {
    if (!openFile || !host) return
    setSaving(true)
    try {
      await api.writeFile(host, openFile, fileContent)
      setOriginalContent(fileContent)
      setSaved(true)
      toast.success('文件已保存')
    } catch (err) {
      toast.error(`保存失败: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const onEditorMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.addCommand(
      // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.KeyS
      2048 | 49, // CtrlCmd(2048) + KeyS(49)
      () => saveFile()
    )
  }

  const onContentChange = (value: string | undefined) => {
    const v = value ?? ''
    setFileContent(v)
    setSaved(v === originalContent)
  }

  const isDirty = !saved

  // 渲染树节点
  const renderNode = (node: TreeNode, depth: number) => {
    const { entry } = node
    const isExpanded = expandedPaths.has(entry.path)
    const isSelected = openFile === entry.path

    if (entry.is_dir) {
      return (
        <div key={entry.path}>
          <button
            className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-muted ${
              isExpanded ? 'text-foreground' : 'text-muted-foreground'
            }`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => toggleExpand(node)}
          >
            {node.loading ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen className="size-3.5 shrink-0 text-amber-500" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-amber-500" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded &&
            node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      )
    }

    return (
      <button
        key={entry.path}
        className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-muted ${
          isSelected ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => openFileHandler(entry.path)}
      >
        <FileText className="size-3.5 shrink-0 text-blue-500" />
        <span className="truncate">{entry.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
          {fmtSize(entry.size)}
        </span>
      </button>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4 lg:p-6">
      {/* 工具栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">文件编辑器</h2>
          <p className="text-muted-foreground text-sm">
            可视化编辑远程主机配置文件，无需使用 vi
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={host} onValueChange={setHost}>
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
            <Button variant="outline" size="sm" onClick={handleDisconnect}>
              断开
            </Button>
          ) : (
            <Button size="sm" onClick={handleConnect} disabled={!host || treeLoading}>
              {treeLoading ? (
                <Loader2 className="size-3.5 animate-spin mr-1" />
              ) : null}
              连接
            </Button>
          )}
          {connected && (
            <div className="flex items-center gap-1 rounded-md border">
            <Input
              className="h-8 w-48 border-0 text-xs font-mono"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadRoot()}
              placeholder="/"
            />
            <Button variant="ghost" size="icon" className="size-7" onClick={loadRoot}>
              <RefreshCw className="size-3.5" />
            </Button>
            </div>
          )}
        </div>
      </div>

      {/* 主体 */}
      <div className="flex min-h-0 flex-1 gap-0 overflow-hidden rounded-lg border">
        {/* 左侧文件树 */}
        <div className="w-64 shrink-0 overflow-auto border-r bg-background">
          {treeLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              加载中...
            </div>
          ) : tree.length === 0 && connected ? (
            <div className="p-4 text-sm text-muted-foreground">
              目录为空或无法访问
            </div>
          ) : !connected ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              请选择主机后点击「连接」
            </div>
          ) : (
            <div className="py-1">{tree.map((node) => renderNode(node, 0))}</div>
          )}
        </div>

        {/* 右侧编辑器 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {openFile ? (
            <>
              {/* 文件头部 */}
              <div className="flex items-center gap-2 border-b px-3 py-1.5">
                <FileText className="size-3.5 text-blue-500" />
                <span className="truncate text-sm font-mono">{openFile}</span>
                {isDirty && (
                  <Badge variant="outline" className="text-amber-600 text-[10px]">
                    未保存
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={isDirty ? 'default' : 'outline'}
                    onClick={saveFile}
                    disabled={saving || saved}
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    <span className="ml-1">{saving ? '保存中…' : '保存'}</span>
                  </Button>
                </div>
              </div>
              {/* Monaco Editor */}
              <div className="min-h-0 flex-1">
                {fileLoading ? (
                  <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    加载文件...
                  </div>
                ) : (
                  <Editor
                    height="100%"
                    language={getLang(openFile)}
                    value={fileContent}
                    onChange={onContentChange}
                    onMount={onEditorMount}
                    theme="vs"
                    options={{
                      fontSize: 13,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      minimap: { enabled: false },
                      lineNumbers: 'on',
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      tabSize: 2,
                      renderWhitespace: 'selection',
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <div className="text-center">
                <FileText className="mx-auto size-8 opacity-30" />
                <p className="mt-2 text-sm">从左侧文件树选择文件进行编辑</p>
                <p className="text-xs text-muted-foreground/60">
                  支持语法高亮 · Ctrl+S 保存
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
