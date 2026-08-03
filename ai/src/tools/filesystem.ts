/**
 * 文件系统工具
 * 通过 Rust 后端 SFTP 读取/写入远程文件
 */
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { getConfig } from '../config.js'

/**
 * LangChain Tool: read_file
 * 读取远程文件内容
 */
export const readFileTool = tool(
  async ({ host, path }: { host: string; path: string }) => {
    const config = getConfig()
    
    const res = await fetch(
      `${config.backendUrl}/api/files/${encodeURIComponent(host)}/read?path=${encodeURIComponent(path)}`
    )
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error((err as { error?: string }).error || `读取文件失败: HTTP ${res.status}`)
    }
    
    const data = await res.json() as { content: string; size: number }
    return data.content
  },
  {
    name: 'read_file',
    description: '读取远程主机上的文件内容。用于查看配置文件、日志文件等。',
    schema: z.object({
      host: z.string().describe('远程主机名称'),
      path: z.string().describe('文件绝对路径，如 /etc/nginx/nginx.conf'),
    }),
  }
)

/**
 * LangChain Tool: write_file
 * 写入远程文件（会触发审批）
 */
export const writeFileTool = tool(
  async ({ host, path, content }: { host: string; path: string; content: string }) => {
    const config = getConfig()
    
    const res = await fetch(
      `${config.backendUrl}/api/files/${encodeURIComponent(host)}/write`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      }
    )
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error((err as { error?: string }).error || `写入文件失败: HTTP ${res.status}`)
    }
    
    return `文件 ${path} 已成功保存`
  },
  {
    name: 'write_file',
    description: `修改远程主机上的文件内容。注意：此操作需要用户审批确认。
文件路径必须是绝对路径。内容将完整替换原文件。`,
    schema: z.object({
      host: z.string().describe('远程主机名称'),
      path: z.string().describe('文件绝对路径'),
      content: z.string().describe('要写入的完整文件内容'),
    }),
  }
)

/**
 * LangChain Tool: list_directory
 * 列出远程目录内容
 */
export const listDirectoryTool = tool(
  async ({ host, path }: { host: string; path: string }) => {
    const config = getConfig()
    
    const res = await fetch(
      `${config.backendUrl}/api/files/${encodeURIComponent(host)}/list?path=${encodeURIComponent(path)}`
    )
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error((err as { error?: string }).error || `列出目录失败: HTTP ${res.status}`)
    }
    
    const data = await res.json() as { entries: { name: string; path: string; size: number; is_dir: boolean }[] }
    
    return data.entries
      .map((e) => `${e.is_dir ? '[DIR]' : '[FILE]'} ${e.name} (${e.size} bytes)`)
      .join('\n')
  },
  {
    name: 'list_directory',
    description: '列出远程主机上的目录内容。',
    schema: z.object({
      host: z.string().describe('远程主机名称'),
      path: z.string().describe('目录绝对路径，如 /etc/nginx/'),
    }),
  }
)
