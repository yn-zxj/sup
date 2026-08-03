/**
 * 审批流程客户端
 * 向 Rust 后端提交审批请求并等待结果
 */
import { getConfig } from '../config.js'

export interface ApprovalRequest {
  id: string
  host: string
  command: string
  risk: 'safe' | 'risky' | 'dangerous'
  timeout_ms: number
}

export interface ApprovalResult {
  id: string
  approved: boolean
  rejected_reason?: string
}

/**
 * 提交审批请求并等待结果
 * 审批流程：
 * 1. AI Service → POST /api/ai/request-approval → Rust Backend
 * 2. Rust Backend 存储审批请求，通过 WebSocket 推送到前端
 * 3. 用户在前端审批
 * 4. Rust Backend → AI Service 返回审批结果
 */
export async function requestApproval(
  host: string,
  command: string,
  risk: string
): Promise<ApprovalResult> {
  const config = getConfig()
  
  try {
    const res = await fetch(`${config.backendUrl}/api/ai/request-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, command, risk }),
    })
    
    if (!res.ok) {
      return { id: '', approved: false, rejected_reason: `审批请求失败: HTTP ${res.status}` }
    }
    
    const data = await res.json() as { result: ApprovalResult }
    return data.result
  } catch (err) {
    return { 
      id: '', 
      approved: false, 
      rejected_reason: `审批服务不可用: ${(err as Error).message}` 
    }
  }
}
