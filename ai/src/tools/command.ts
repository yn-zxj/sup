/**
 * 远程命令执行工具
 * 通过 Rust 后端在远程主机上执行命令
 */
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { getConfig } from '../config.js'
import { requestApproval } from '../approval.js'

interface CommandResult {
  stdout: string
  stderr: string
  exit_code: number
}

interface RunCommandArgs {
  host: string
  command: string
  risk?: string
}

/**
 * 在远程主机上执行命令
 * 路由到 Rust 后端，Rust 后端通过 SSH 执行
 */
async function executeRemoteCommand(host: string, command: string): Promise<CommandResult> {
  const config = getConfig()
  
  const res = await fetch(`${config.backendUrl}/api/ai/exec-command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, command }),
  })
  
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error((err as { error?: string }).error || `命令执行失败: HTTP ${res.status}`)
  }
  
  return res.json() as Promise<CommandResult>
}

/**
 * LangChain Tool: run_command
 * 在远程主机上执行 Shell 命令
 */
export const runCommandTool = tool(
  async ({ host, command }: RunCommandArgs) => {
    // 执行命令（Rust 后端会进行风险检查）
    const result = await executeRemoteCommand(host, command)
    
    let output = ''
    if (result.stdout) {
      output += result.stdout
    }
    if (result.stderr) {
      output += `\n[STDERR]\n${result.stderr}`
    }
    output += `\n[退出码: ${result.exit_code}]`
    
    return output
  },
  {
    name: 'run_command',
    description: `在远程主机上执行 Shell 命令并返回输出。用于获取系统信息、检查状态等。
安全命令（如 ls, cat, df, ps）会直接执行。
危险命令（如 rm -rf, shutdown）会触发审批流程，需要用户在 UI 上确认。`,
    schema: z.object({
      host: z.string().describe('远程主机名称'),
      command: z.string().describe('要执行的 Shell 命令'),
    }),
  }
)

/**
 * LangChain Tool: system_inspect
 * 一键执行主机巡检，收集系统关键指标
 */
export const systemInspectTool = tool(
  async ({ host }: { host: string }) => {
    const commands = [
      { name: '系统信息', cmd: 'uname -a && hostname && uptime' },
      { name: 'CPU 使用', cmd: 'top -bn1 | head -5' },
      { name: '内存使用', cmd: 'free -h' },
      { name: '磁盘使用', cmd: 'df -h' },
      { name: '网络端口', cmd: 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null' },
      { name: '内存 Top 进程', cmd: 'ps aux --sort=-%mem | head -10' },
    ]
    
    const results: string[] = []
    for (const { name, cmd } of commands) {
      try {
        const result = await executeRemoteCommand(host, cmd)
        results.push(`=== ${name} ===\n${result.stdout}`)
      } catch (err) {
        results.push(`=== ${name} ===\n执行失败: ${(err as Error).message}`)
      }
    }
    
    return results.join('\n\n')
  },
  {
    name: 'system_inspect',
    description: `一键执行主机巡检，收集 CPU、内存、磁盘、网络等系统关键指标。
返回结构化的检查结果，适合生成巡检报告。`,
    schema: z.object({
      host: z.string().describe('远程主机名称'),
    }),
  }
)
