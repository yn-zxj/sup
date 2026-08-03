/**
 * LangGraph Agent 定义
 * 使用 StateGraph 编排 AI Agent 的推理和执行流程
 */
import { StateGraph, END, START, Annotation } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages'
import { getConfig } from './config.js'
import { ASSISTANT_PROMPT } from './prompts/assistant.js'
import { INSPECTOR_PROMPT } from './prompts/inspector.js'
import { runCommandTool, systemInspectTool } from './tools/command.js'
import { readFileTool, writeFileTool, listDirectoryTool } from './tools/filesystem.js'

// 所有可用工具
const ALL_TOOLS = [
  runCommandTool,
  systemInspectTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
]

// Agent 状态定义
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  host: Annotation<string>({
    reducer: (_, update) => update,
    default: () => '',
  }),
  mode: Annotation<'assistant' | 'inspector'>({
    reducer: (_, update) => update,
    default: () => 'assistant',
  }),
})

// 工具节点
const toolNode = new ToolNode(ALL_TOOLS)

/**
 * 创建 LLM 实例
 */
function createLLM() {
  const config = getConfig()
  return new ChatOpenAI({
    modelName: config.model,
    temperature: 0.3,
    openAIApiKey: config.apiKey,
    configuration: {
      baseURL: config.baseUrl,
    },
  })
}

/**
 * Agent 推理节点
 * 调用 LLM，让其决定是否需要使用工具
 */
async function agentNode(state: typeof AgentState.State) {
  const llm = createLLM()
  const llmWithTools = llm.bindTools(ALL_TOOLS)

  const systemPrompt = state.mode === 'inspector' ? INSPECTOR_PROMPT : ASSISTANT_PROMPT

  const systemMessage = new HumanMessage({
    content: `${systemPrompt}\n\n当前连接的主机: ${state.host}`,
  })

  const messages = [systemMessage, ...state.messages]

  const response = await llmWithTools.invoke(messages)

  return {
    messages: [response],
  }
}

/**
 * 路由函数：判断是否需要继续使用工具
 */
function shouldContinue(state: typeof AgentState.State): 'tools' | typeof END {
  const lastMessage = state.messages[state.messages.length - 1]

  if (
    lastMessage instanceof AIMessage &&
    (lastMessage as AIMessage).tool_calls &&
    (lastMessage as AIMessage).tool_calls!.length > 0
  ) {
    return 'tools'
  }

  return END
}

/**
 * 创建 Agent Graph
 */
export function createAgent() {
  const workflow = new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'agent')

  return workflow.compile()
}

/**
 * 运行 Agent，使用流式回调
 */
export async function* runAgentStream(
  host: string,
  message: string,
  mode: 'assistant' | 'inspector' = 'assistant'
): AsyncGenerator<{
  type: 'text' | 'tool_start' | 'tool_end' | 'error' | 'done'
  content?: string
  toolName?: string
  toolOutput?: string
  toolCallId?: string
}> {
  const agent = createAgent()

  const initialState = {
    messages: [new HumanMessage(message)],
    host,
    mode,
  }

  try {
    const stream = await agent.stream(initialState, {
      streamMode: 'updates',
    })

    for await (const update of stream) {
      // update 是 { nodeName: { messages: [...] } }
      for (const [nodeName, nodeOutput] of Object.entries(update)) {
        const output = nodeOutput as { messages?: BaseMessage[] }
        if (!output.messages) continue

        for (const msg of output.messages) {
          if (msg instanceof AIMessage) {
            // 工具调用（先发，确保前端展示顺序：工具 → 文本 → 审批 → 总结）
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                yield {
                  type: 'tool_start',
                  toolName: tc.name,
                  content: JSON.stringify(tc.args),
                  toolCallId: tc.id,
                }
              }
            }

            // AI 的文本回复
            const content = typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content)

            if (content.length > 0) {
              yield { type: 'text', content }
            }
          } else if (msg instanceof ToolMessage) {
            yield {
              type: 'tool_end',
              toolName: msg.name,
              toolOutput: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              toolCallId: msg.tool_call_id,
            }
          }
        }
      }
    }

    yield { type: 'done' }
  } catch (err) {
    yield { type: 'error', content: (err as Error).message }
  }
}
