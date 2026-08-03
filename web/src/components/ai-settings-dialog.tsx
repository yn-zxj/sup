import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { Loader2, Eye, EyeOff } from 'lucide-react'

interface AiConfigData {
  enabled: boolean
  provider: string
  base_url: string
  model: string
  port: number
  has_api_key: boolean
}

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { value: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { value: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { value: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
  { value: 'custom', label: '自定义', baseUrl: '' },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}

export function AiSettingsDialog({ open, onOpenChange, onSaved }: Props) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)

  const [enabled, setEnabled] = useState(true)
  const [provider, setProvider] = useState('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('gpt-4o')
  const [port, setPort] = useState(7799)
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)

  // 加载配置
  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch('/api/ai/config')
      .then((r) => r.json())
      .then((data: AiConfigData) => {
        setEnabled(data.enabled)
        setProvider(data.provider)
        setBaseUrl(data.base_url)
        setModel(data.model)
        setPort(data.port)
        setHasApiKey(data.has_api_key)
        setApiKey('')
      })
      .catch(() => toast.error('加载 AI 配置失败'))
      .finally(() => setLoading(false))
  }, [open])

  // 切换 provider 时自动填充 base_url
  const handleProviderChange = (v: string) => {
    setProvider(v)
    const p = PROVIDERS.find((x) => x.value === v)
    if (p && p.baseUrl) setBaseUrl(p.baseUrl)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        enabled,
        provider,
        base_url: baseUrl,
        model,
        port,
      }
      // 只有修改了 api_key 才发送
      if (apiKey) {
        body.api_key = apiKey
      }
      const r = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: '保存失败' }))
        throw new Error((err as { error?: string }).error || '保存失败')
      }
      toast.success('AI 配置已保存，重启后生效')
      setApiKey('')
      onOpenChange(false)
      onSaved?.()
    } catch (err) {
      toast.error(`保存失败: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>AI 大模型配置</DialogTitle>
          <DialogDescription>
            配置大模型 API 信息，支持 OpenAI 兼容接口（DeepSeek、通义千问等）
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            {/* 启用开关 */}
            <div className="flex items-center justify-between">
              <Label htmlFor="ai-enabled" className="text-sm">启用 AI 功能</Label>
              <div className="flex items-center gap-2">
                <input
                  id="ai-enabled"
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="size-4 rounded"
                />
              </div>
            </div>

            {/* Provider */}
            <div className="grid gap-1.5">
              <Label className="text-xs">模型提供商</Label>
              <Select value={provider} onValueChange={handleProviderChange}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Base URL */}
            <div className="grid gap-1.5">
              <Label className="text-xs">API 地址</Label>
              <Input
                className="h-9 font-mono text-xs"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>

            {/* Model */}
            <div className="grid gap-1.5">
              <Label className="text-xs">模型名称</Label>
              <Input
                className="h-9 text-xs"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o"
              />
              <p className="text-[10px] text-muted-foreground">
                常用：gpt-4o / gpt-4o-mini / deepseek-chat / qwen-plus
              </p>
            </div>

            {/* API Key */}
            <div className="grid gap-1.5">
              <Label className="text-xs">
                API Key
                {hasApiKey && !apiKey && (
                  <span className="ml-1 text-green-600">（已保存到系统钥匙串）</span>
                )}
              </Label>
              <div className="relative">
                <Input
                  className="h-9 pr-9 font-mono text-xs"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasApiKey ? '留空则不修改' : 'sk-...'}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={handleSave} disabled={loading || saving}>
            {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
            保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
