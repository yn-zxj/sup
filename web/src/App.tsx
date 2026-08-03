import { useCallback, useEffect, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { api, type HostItem } from '@/lib/api'
import { OverviewPage } from '@/components/overview-page'
import { HostsPage } from '@/components/hosts-page'
import { UploadPage } from '@/components/upload-page'
import { LogsPage } from '@/components/logs-page'
import { TerminalPage } from '@/components/terminal-page'
import { FileEditorPage } from '@/components/file-editor-page'
import {
  LayoutDashboard,
  Server,
  Upload,
  ScrollText,
  SquareTerminal,
  Rocket,
  FileCode,
} from 'lucide-react'

const NAV = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'hosts', label: '主机', icon: Server },
  { id: 'upload', label: '上传', icon: Upload },
  { id: 'logs', label: '日志', icon: ScrollText },
  { id: 'terminal', label: '终端', icon: SquareTerminal },
  { id: 'files', label: '文件编辑', icon: FileCode },
]

export default function App() {
  const [page, setPage] = useState('overview')
  const [hosts, setHosts] = useState<HostItem[]>([])

  const refreshHosts = useCallback(() => {
    api.hosts().then(setHosts).catch(() => {})
  }, [])
  useEffect(refreshHosts, [refreshHosts])

  const title = NAV.find((n) => n.id === page)?.label ?? ''

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="offcanvas">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" onClick={() => setPage('overview')}>
                <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
                  <Rocket className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="font-semibold">sup</span>
                  <span className="text-muted-foreground text-xs">轻量增量部署</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((n) => (
                  <SidebarMenuItem key={n.id}>
                    <SidebarMenuButton isActive={page === n.id} onClick={() => setPage(n.id)}>
                      <n.icon />
                      <span>{n.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <p className="text-muted-foreground px-2 pb-2 text-xs">sup v0.1.0</p>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="h-svh overflow-hidden md:peer-data-[variant=inset]:h-[calc(100svh-1rem)]">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-center"
          />
          <span className="text-sm font-medium">{title}</span>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto">
          {page === 'overview' && <OverviewPage hosts={hosts} onNavigate={setPage} />}
          {page === 'hosts' && <HostsPage onHostsChanged={refreshHosts} />}
          {page === 'upload' && <UploadPage hosts={hosts} />}
          {page === 'logs' && <LogsPage hosts={hosts} />}
          {page === 'terminal' && <TerminalPage hosts={hosts} />}
          {page === 'files' && <FileEditorPage hosts={hosts} />}
        </main>
      </SidebarInset>
      <Toaster richColors position="top-right" />
    </SidebarProvider>
  )
}
