import {
  AudioOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Input,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgentConsole } from './AgentConsoleContext'
import {
  executeTask,
  fetchHosts,
  fetchRuntimeLlmProfile,
  fetchTasks,
} from '../services/api'

const quickPrompts = [
  '查询当前磁盘剩余空间',
  '分析这四个服务器的磁盘情况',
  '22 端口被谁占用了',
  '检查 nginx 相关服务和进程',
]

const pendingPhases = [
  '连接目标主机并读取上下文',
  '分析当前状态并生成执行计划',
  '调用运维工具并验证结果',
  '整理结论并准备返回',
]

function getTaskStatusColor(status: string) {
  if (status === 'succeeded') return 'green'
  if (status === 'waiting_approval') return 'gold'
  if (status === 'failed') return 'red'
  return 'blue'
}

function formatTimestamp(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ensureMarkdown(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed
}

export function AgentPanel() {
  const [messageApi, contextHolder] = message.useMessage()
  const [listening, setListening] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [pendingDraft, setPendingDraft] = useState<{
    prompt: string
    hostIds: number[]
  } | null>(null)
  const [pendingPhaseIndex, setPendingPhaseIndex] = useState(0)
  const [streamingTaskId, setStreamingTaskId] = useState<number | null>(null)
  const [streamingSummary, setStreamingSummary] = useState('')
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const streamedTaskRef = useRef<number | null>(null)
  const queryClient = useQueryClient()
  const {
    prompt,
    setPrompt,
    sessionId,
    selectedHosts,
    setSelectedHosts,
    routePinnedHostId,
  } = useAgentConsole()

  const { data: hosts = [] } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
  })

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
    refetchInterval: 5000,
  })

  const { data: runtimeProfile } = useQuery({
    queryKey: ['runtime-llm-profile'],
    queryFn: fetchRuntimeLlmProfile,
    refetchInterval: 30000,
  })

  const executeMutation = useMutation({
    mutationFn: executeTask,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      setPendingDraft(null)
      setDispatching(false)
      setPrompt('')
    },
    onError: (error: any) => {
      setPendingDraft(null)
      setDispatching(false)
      messageApi.error(error?.response?.data?.detail ?? 'Agent 任务提交失败')
    },
  })

  const hostNameMap = useMemo(
    () => new Map<number, string>(hosts.map((host: any) => [Number(host.id), String(host.name)])),
    [hosts],
  )

  const activeModel = runtimeProfile?.active?.gateway_custom_model_option_name
    ?? runtimeProfile?.active?.gateway_model
    ?? runtimeProfile?.active?.claude_model
    ?? '未配置'

  const sessionTasks = useMemo(
    () => tasks
      .filter((task: any) => task.session_id === sessionId)
      .sort((a: any, b: any) => a.id - b.id),
    [tasks, sessionId],
  )

  useEffect(() => {
    if (!hosts.length || selectedHosts.length || routePinnedHostId !== null) return
    setSelectedHosts(hosts.map((host: any) => host.id))
  }, [hosts, routePinnedHostId, selectedHosts.length, setSelectedHosts])

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel()
    }
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const node = conversationRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [dispatching, pendingDraft, sessionTasks.length])

  useEffect(() => {
    if (!pendingDraft || !sessionTasks.length) return
    const latestTask = sessionTasks.at(-1)
    if (!latestTask) return
    if (latestTask.prompt === pendingDraft.prompt && latestTask.target_hosts?.length) {
      setPendingDraft(null)
      setPendingPhaseIndex(0)
    }
  }, [pendingDraft, sessionTasks])

  useEffect(() => {
    if (!pendingDraft) {
      setPendingPhaseIndex(0)
      return
    }
    const timer = window.setInterval(() => {
      setPendingPhaseIndex((index) => (index + 1) % pendingPhases.length)
    }, 1400)
    return () => window.clearInterval(timer)
  }, [pendingDraft])

  const latestTask = sessionTasks.at(-1)
  const latestTaskId = latestTask?.id ?? null
  const latestTaskSummary = latestTask
    ? (latestTask.result_json?.summary ?? latestTask.plan_json?.plan_explanation ?? '')
    : ''

  useEffect(() => {
    if (!latestTaskId || !latestTaskSummary || pendingDraft) return
    if (streamedTaskRef.current === latestTaskId) return
    streamedTaskRef.current = latestTaskId
    setStreamingTaskId(latestTaskId)
    setStreamingSummary('')

    let cursor = 0
    const chunk = Math.max(2, Math.ceil(latestTaskSummary.length / 42))
    const timer = window.setInterval(() => {
      cursor = Math.min(latestTaskSummary.length, cursor + chunk)
      setStreamingSummary(latestTaskSummary.slice(0, cursor))
      if (cursor >= latestTaskSummary.length) {
        window.clearInterval(timer)
      }
    }, 36)

    return () => window.clearInterval(timer)
  }, [latestTaskId, latestTaskSummary, pendingDraft])

  const startVoiceInput = () => {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!Recognition) {
      messageApi.warning('当前浏览器不支持语音识别，可改用 Chrome。')
      return
    }
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.interimResults = false
    recognition.continuous = false
    recognition.onstart = () => setListening(true)
    recognition.onend = () => setListening(false)
    recognition.onerror = () => {
      setListening(false)
      messageApi.error('语音识别失败，请重试')
    }
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript ?? ''
      if (transcript) {
        setPrompt(transcript)
      }
    }
    recognition.start()
  }

  const runPrompt = () => {
    if (!prompt.trim()) {
      messageApi.warning('先输入一个任务目标')
      return
    }
    if (!selectedHosts.length) {
      messageApi.warning('至少选择一台目标主机')
      return
    }
    const nextPrompt = prompt.trim()
    const nextHostIds = [...selectedHosts]
    setPendingDraft({
      prompt: nextPrompt,
      hostIds: nextHostIds,
    })
    setDispatching(true)
    window.setTimeout(() => setDispatching(false), 1200)
    executeMutation.mutate({
      prompt: nextPrompt,
      selected_host_ids: nextHostIds,
      session_id: sessionId,
      auto_approve: false,
    })
  }

  const conversationEntries = useMemo(() => {
    const entries: Array<{
      type: 'user' | 'assistant'
      key: string
      task?: any
      prompt?: string
      pending?: boolean
    }> = []
    sessionTasks.slice(-18).forEach((task: any) => {
      entries.push({ type: 'user', key: `user-${task.id}`, task })
      entries.push({ type: 'assistant', key: `assistant-${task.id}`, task })
    })
    if (pendingDraft?.prompt) {
      entries.push({ type: 'user', key: 'pending-user', prompt: pendingDraft.prompt, pending: true })
      entries.push({ type: 'assistant', key: 'pending-assistant', pending: true })
    }
    return entries
  }, [pendingDraft, sessionTasks])

  const selectedHostNames = selectedHosts.map((hostId) => hostNameMap.get(hostId) ?? `host-${hostId}`)
  const canExecute = Boolean(prompt.trim() && selectedHosts.length)
  const isIdle = conversationEntries.length === 0

  return (
    <div className={`agent-stage window-draggable${isIdle ? ' agent-stage--idle' : ''}${pendingDraft ? ' agent-stage--busy' : ''}`}>
      {contextHolder}

      <div className="agent-stage__threadbar window-drag-handle">
        <div className="agent-stage__threadbar-main">
          <Typography.Text strong>XFusion Agent</Typography.Text>
          <Typography.Text type="secondary">
            会话 {sessionId.slice(0, 14)}
          </Typography.Text>
        </div>
        <Space size={8} wrap className="agent-stage__threadbar-meta">
          <Tag color="geekblue">{activeModel}</Tag>
          <Tag color="green">{selectedHosts.length} 台主机</Tag>
        </Space>
      </div>

      <div ref={conversationRef} className="agent-stage__stream">
        {conversationEntries.length ? conversationEntries.map((entry) => {
          if (entry.type === 'user') {
            const taskHosts = (entry.task?.target_hosts as number[] | undefined)
              ?? (entry.pending ? pendingDraft?.hostIds : selectedHosts)
              ?? selectedHosts
            return (
              <article key={entry.key} className="agent-message agent-message--user">
                <div className="agent-message__meta">
                  <Space size={6}>
                    <UserOutlined />
                    <span>你</span>
                    <span>{formatTimestamp(entry.task?.created_at) || (entry.pending ? '发送中' : '')}</span>
                  </Space>
                </div>
                <div className="agent-message__body">
                  <Typography.Paragraph style={{ marginBottom: 0 }}>
                    {entry.prompt ?? entry.task?.prompt}
                  </Typography.Paragraph>
                  <Space wrap size={6} style={{ marginTop: 10 }}>
                    {taskHosts.slice(0, 4).map((hostId) => (
                      <Tag key={`${entry.key}-${hostId}`}>
                        {String(hostNameMap.get(hostId) ?? `host-${hostId}`)}
                      </Tag>
                    ))}
                  </Space>
                </div>
              </article>
            )
          }

          if (entry.pending) {
            return (
              <article key={entry.key} className="agent-message agent-message--assistant">
                <div className="agent-message__meta">
                  <Space size={6}>
                    <RobotOutlined />
                    <span>XFusion Agent</span>
                    <Tag color="blue">执行中</Tag>
                  </Space>
                </div>
                <div className="agent-message__body agent-message__body--pending">
                  <div className="agent-typing">
                    <span />
                    <span />
                    <span />
                  </div>
                  <Typography.Paragraph style={{ marginBottom: 0 }}>
                    {pendingPhases[pendingPhaseIndex]}
                  </Typography.Paragraph>
                  <Typography.Text type="secondary" className="agent-message__phase-caption">
                    Agent 正在持续规划和执行，结果会在当前线程里逐步返回。
                  </Typography.Text>
                </div>
              </article>
            )
          }

          const task = entry.task
          const toolCalls = task.plan_json?.ai?.tool_calls ?? []
          const perHost = task.result_json?.per_host ?? []
          const finalSummary = task.result_json?.summary ?? task.plan_json?.plan_explanation ?? '任务已提交，等待结果。'
          const visibleSummary = task.id === streamingTaskId && streamingSummary
            ? streamingSummary
            : finalSummary
          return (
            <article key={entry.key} className="agent-message agent-message--assistant">
              <div className="agent-message__meta">
                <Space size={6}>
                  <RobotOutlined />
                  <span>XFusion Agent</span>
                  <Tag color={getTaskStatusColor(task.status)}>{task.status}</Tag>
                  <span>{formatTimestamp(task.updated_at)}</span>
                </Space>
              </div>
              <div className="agent-message__body">
                <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
                  {task.title}
                </Typography.Title>
                <div className="agent-message__richtext">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {ensureMarkdown(visibleSummary)}
                  </ReactMarkdown>
                  {task.id === streamingTaskId && visibleSummary.length < finalSummary.length ? (
                    <span className="agent-message__cursor" aria-hidden="true">▍</span>
                  ) : null}
                </div>
                {(toolCalls.length || perHost.length) ? (
                  <details className="agent-message__details">
                    <summary>执行细节</summary>
                    <div className="agent-message__details-body">
                      <div className="agent-message__detail-line">
                        <span>任务类型</span>
                        <strong>{task.task_type}</strong>
                      </div>
                      {task.plan_json?.ai?.gateway_model ? (
                        <div className="agent-message__detail-line">
                          <span>模型</span>
                          <strong>{task.plan_json.ai.gateway_model}</strong>
                        </div>
                      ) : null}
                      {toolCalls.length ? (
                        <div className="agent-message__detail-line">
                          <span>工具调用</span>
                          <strong>{toolCalls.length} 次</strong>
                        </div>
                      ) : null}
                      {perHost.length ? (
                        <div className="agent-message__host-results">
                          {perHost.map((item: any, index: number) => (
                            <div key={`${task.id}-host-${index}`} className="agent-message__host-row">
                              <span>{hostNameMap.get(item.host_id) ?? `host-${item.host_id}`}</span>
                              <Tag color={item.success ? 'green' : 'red'}>
                                {item.success ? '成功' : '失败'}
                              </Tag>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </div>
            </article>
          )
        }) : (
          <div className="agent-stage__empty">
            <Typography.Title level={3} style={{ margin: 0 }}>
              今天想让 Agent 处理什么？
            </Typography.Title>
            <Typography.Paragraph className="agent-stage__empty-copy">
              直接用自然语言描述目标。Agent 会结合当前主机、模型和工具能力，自动规划并返回结果。
            </Typography.Paragraph>
            <Space wrap size={[8, 8]} className="agent-stage__empty-picks">
              {quickPrompts.map((item) => (
                <Tag
                  key={item}
                  className="agent-stage__quick-chip"
                  onClick={() => setPrompt(item)}
                >
                  {item}
                </Tag>
              ))}
            </Space>
          </div>
        )}
      </div>

      <div className={`agent-stage__composer${isIdle ? ' agent-stage__composer--spotlight' : ''}`}>
        <div className="agent-stage__composer-statusbar">
          <Tag color="geekblue">{activeModel}</Tag>
          <Tag color="green">{selectedHosts.length} 台主机</Tag>
          <Typography.Text type="secondary">
            {selectedHostNames.slice(0, 3).join('、') || '未选择主机'}
            {selectedHostNames.length > 3 ? ` 等 ${selectedHostNames.length} 台` : ''}
          </Typography.Text>
        </div>
        <Input.TextArea
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault()
              runPrompt()
            }
          }}
          placeholder="给 Agent 一个目标，例如：分析这四台服务器里哪一台磁盘压力最大，并给出清理建议。"
        />
        {isIdle ? (
          <div className="agent-stage__composer-suggestions">
            {quickPrompts.map((item) => (
              <Tag
                key={item}
                className="agent-stage__quick-chip"
                onClick={() => setPrompt(item)}
              >
                {item}
              </Tag>
            ))}
          </div>
        ) : null}
        <div className="agent-stage__composer-actions">
          <Button icon={<AudioOutlined />} onClick={startVoiceInput} loading={listening}>
            {listening ? '正在听写' : '语音输入'}
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={!canExecute || Boolean(pendingDraft)}
            loading={dispatching}
            onClick={runPrompt}
          >
            {pendingDraft ? 'Agent 思考中' : '发送给 Agent'}
          </Button>
        </div>
      </div>

    </div>
  )
}
