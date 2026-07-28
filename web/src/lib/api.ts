export interface HostItem {
  name: string
  host: string
  port: number
  user: string
  auth: 'key' | 'password'
  remote_root?: string | null
  note?: string | null
}

export interface SaveHostReq {
  name: string
  host: string
  port: number
  user: string
  key_path?: string
  password?: string
  passphrase?: string
  remote_root?: string
  note?: string
}

export interface TaskRow {
  id: number
  host: string
  started_at: string
  duration_ms: number
  total: number
  ok: number
  failed: number
  skipped: number
}

export interface FileRow {
  id: number
  task_id: number
  local: string
  remote: string
  size: number
  result: string
  error?: string | null
  duration_ms: number
}

export interface MapRow {
  local: string
  remote: string
}

export interface Preset {
  name: string
  host: string
  maps: MapRow[]
}

export interface ValidateResp {
  entries: { local: string; remote: string; size: number }[]
  missing: string[]
}

export interface RunStatus {
  total: number
  done: number
  ok: number
  failed: number
  bytes_total: number
  bytes_done: number
  current: string
  finished: boolean
  task_id?: number | null
  failures: { local: string; error: string }[]
  error?: string | null
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j.error) msg = j.error
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return r.json()
}

export const api = {
  hosts: () => req<HostItem[]>('/api/hosts'),
  saveHost: (h: SaveHostReq) =>
    req<{ ok: boolean }>('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(h),
    }),
  deleteHost: (name: string) =>
    req<{ ok: boolean }>(`/api/hosts/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  testHost: (name: string) =>
    req<{ ok: boolean }>(`/api/hosts/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    }),
  presets: () => req<Preset[]>('/api/presets'),
  savePreset: (p: Preset) =>
    req<{ ok: boolean }>('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }),
  deletePreset: (name: string) =>
    req<{ ok: boolean }>(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  logs: (params: { host?: string; failed?: boolean; limit?: number }) => {
    const q = new URLSearchParams()
    if (params.host) q.set('host', params.host)
    if (params.failed) q.set('failed', 'true')
    if (params.limit) q.set('limit', String(params.limit))
    return req<TaskRow[]>(`/api/logs?${q}`)
  },
  logDetail: (id: number) => req<{ task: TaskRow; files: FileRow[] }>(`/api/logs/${id}`),
  validate: (host: string, maps: MapRow[]) =>
    req<ValidateResp>('/api/push/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, maps }),
    }),
  runPush: (host: string, maps: MapRow[]) =>
    req<{ run_id: number }>('/api/push/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, maps }),
    }),
  pushStatus: (runId: number) => req<RunStatus>(`/api/push/status/${runId}`),
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
