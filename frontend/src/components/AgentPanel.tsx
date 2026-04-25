import {
  AudioOutlined,
  PlusOutlined,
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
  transcribeVoice,
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

const runningPhases = [
  '观察主机',
  '规划工具',
  '执行动作',
  '校验结果',
]

function parseDfOutput(stdout?: string) {
  return (stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1)
    .map((line) => {
      const parts = line.split(/\s+/)
      if (parts.length < 6) return null
      const [filesystem, size, used, avail, usePercent, mount] = parts
      return {
        filesystem,
        size,
        used,
        avail,
        usePercent,
        mount,
      }
    })
    .filter(Boolean) as Array<{
      filesystem: string
      size: string
      used: string
      avail: string
      usePercent: string
      mount: string
    }>
}

function buildFallbackReport(task: any, hostNameMap: Map<number, string>) {
  const report = task?.result_json?.report_markdown
  if (typeof report === 'string' && report.trim()) {
    return report.trim()
  }
  const perHost = task?.result_json?.per_host ?? []
  if (!perHost.length) {
    return task?.result_json?.summary ?? task?.plan_json?.plan_explanation ?? '任务已提交，等待结果。'
  }
  const isDisk = task?.plan_json?.action_type === 'query_disk'
  if (isDisk) {
    const sections = [
      `# ${task.title}`,
      '',
      '## 执行摘要',
      `- 请求：${task.prompt}`,
      `- 目标主机：${perHost.length} 台`,
      '',
      '## 逐主机结果',
    ]
    perHost.forEach((item: any) => {
      const rows = parseDfOutput(item?.action_result?.stdout)
      const root = rows.find((row) => row.mount === '/') ?? rows[0]
      sections.push('', `### ${hostNameMap.get(item.host_id) ?? item.host_name ?? `host-${item.host_id}`}`)
      sections.push(`- 状态：${item.success ? '成功' : '失败'}`)
      if (root) {
        sections.push(`- 根分区：已用 ${root.used} / 总量 ${root.size} / 可用 ${root.avail} / 使用率 ${root.usePercent}`)
      }
      if (rows.length) {
        sections.push('', '| 挂载点 | 已用 | 总量 | 可用 | 使用率 |')
        sections.push('| --- | --- | --- | --- | --- |')
        rows.slice(0, 4).forEach((row) => {
          sections.push(`| ${row.mount} | ${row.used} | ${row.size} | ${row.avail} | ${row.usePercent} |`)
        })
      }
    })
    return sections.join('\n')
  }
  const sections = [
    `# ${task.title}`,
    '',
    '## 执行摘要',
    `- ${task?.result_json?.summary ?? '任务已完成'}`,
    '',
    '## 逐主机结果',
  ]
  perHost.forEach((item: any) => {
    sections.push('', `### ${hostNameMap.get(item.host_id) ?? item.host_name ?? `host-${item.host_id}`}`)
    sections.push(`- 状态：${item.success ? '成功' : '失败'}`)
    const stdout = item?.action_result?.stdout?.trim()
    if (stdout) {
      sections.push('', '```text', stdout.slice(0, 2500), '```')
    }
  })
  return sections.join('\n')
}

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

function getStepStatusColor(status?: string) {
  if (status === 'completed' || status === 'succeeded') return 'green'
  if (status === 'failed') return 'red'
  if (status === 'pending') return 'gold'
  if (status === 'running' || status === 'started') return 'blue'
  if (status === 'queued') return 'gold'
  return 'default'
}

function getStepTone(status?: string) {
  if (status === 'completed' || status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'pending') return 'warn'
  if (status === 'running') return 'active'
  if (status === 'started') return 'started'
  return 'idle'
}

function getStepStatusLabel(status?: string) {
  return {
    completed: '已完成',
    succeeded: '成功',
    failed: '失败',
    pending: '等待',
    queued: '已排队',
    running: '运行中',
    started: '已启动',
  }[String(status || '')] ?? '未知'
}

function getDisplayStepStatus(step: any, taskStatus: string, index: number, steps: any[]) {
  const status = step?.status
  if ((status === 'running' || status === 'pending') && taskStatus !== 'running') {
    const hasLaterTerminalStep = steps.slice(index + 1).some((item: any) => (
      item?.step_type === step?.step_type
      && item?.title === step?.title
      && ['completed', 'succeeded', 'failed'].includes(String(item?.status))
    ))
    if (hasLaterTerminalStep || ['succeeded', 'failed'].includes(taskStatus)) {
      return status === 'running' ? 'started' : 'queued'
    }
  }
  return status || 'unknown'
}

function getStepPhaseLabel(stepType?: string) {
  return {
    observe: '观察',
    analyze: '分析',
    act: '执行',
    verify: '校验',
    approval: '审批',
  }[String(stepType || '')] ?? '步骤'
}

function getStepSummary(step: any) {
  const output = step?.output_json ?? {}
  if (typeof output.message === 'string') return output.message
  if (Array.isArray(output.per_host)) {
    const success = output.per_host.filter((item: any) => item?.success).length
    return `${success}/${output.per_host.length} 台主机完成`
  }
  if (Array.isArray(output.hosts)) return `已收集 ${output.hosts.length} 台主机上下文`
  if (output.plan?.action_type) return `动作：${output.plan.action_type}`
  if (step?.input_json?.action_type) return `动作：${step.input_json.action_type}`
  return step?.title ?? '等待执行'
}

function getStepHostRows(step: any, hostNameMap: Map<number, string>) {
  const perHost = step?.output_json?.per_host
  if (!Array.isArray(perHost)) return []
  return perHost.map((item: any) => ({
    hostName: hostNameMap.get(Number(item.host_id)) ?? item.host_name ?? `host-${item.host_id}`,
    success: Boolean(item.success),
    stderr: String(item?.action_result?.stderr || item?.verification_result?.stderr || '').trim(),
  }))
}

function getStepMeta(step: any) {
  const input = step?.input_json ?? {}
  const output = step?.output_json ?? {}
  const plan = output.plan ?? {}
  const values: Array<{ label: string; value: string }> = []
  const actionType = plan.action_type ?? input.action_type
  const hostIds = input.host_ids
  const criteria = input.criteria
  if (actionType) values.push({ label: '动作', value: String(actionType) })
  if (Array.isArray(hostIds)) values.push({ label: '目标', value: `${hostIds.length} 台主机` })
  if (Array.isArray(criteria)) values.push({ label: '标准', value: `${criteria.length} 条` })
  if (Array.isArray(output.hosts)) values.push({ label: '上下文', value: `${output.hosts.length} 台主机` })
  if (output.plan?.policy?.risk_level) values.push({ label: '风险', value: String(output.plan.policy.risk_level) })
  return values
}

function getStepPreview(step: any) {
  const output = step?.output_json ?? {}
  if (typeof output.message === 'string') return output.message
  if (output.plan?.plan_explanation) return String(output.plan.plan_explanation)
  if (Array.isArray(output.per_host)) {
    const failed = output.per_host
      .filter((item: any) => !item.success)
      .map((item: any) => item.host_name ?? `host-${item.host_id}`)
    if (failed.length) return `失败主机：${failed.join('、')}`
  }
  return ''
}

function getRunningStepIndex(steps: any[]) {
  const runningIndex = steps.findIndex((step) => step.status === 'running' || step.status === 'pending')
  if (runningIndex >= 0) return runningIndex
  const failedIndex = steps.findIndex((step) => step.status === 'failed')
  if (failedIndex >= 0) return failedIndex
  return Math.max(0, steps.length - 1)
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
  const [transcribing, setTranscribing] = useState(false)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamedTaskRef = useRef<string | null>(null)
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
    onSuccess: (task: any) => {
      queryClient.setQueryData(['tasks'], (oldTasks: any[] | undefined) => {
        const currentTasks = Array.isArray(oldTasks) ? oldTasks : []
        const taskIndex = currentTasks.findIndex((item) => item.id === task.id)
        if (taskIndex >= 0) {
          return currentTasks.map((item, index) => (index === taskIndex ? task : item))
        }
        return [task, ...currentTasks]
      })
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
  const latestTaskReport = latestTask
    ? buildFallbackReport(latestTask, hostNameMap)
    : ''

  useEffect(() => {
    if (!latestTaskId || !latestTaskReport || pendingDraft) return
    const reportSignature = `${latestTaskId}:${latestTask?.status ?? 'unknown'}:${latestTaskReport.length}:${latestTaskReport.slice(0, 48)}`
    if (streamedTaskRef.current === reportSignature) return
    streamedTaskRef.current = reportSignature
    setStreamingTaskId(latestTaskId)
    setStreamingSummary('')

    let cursor = 0
    const chunk = Math.max(4, Math.ceil(latestTaskReport.length / 64))
    const timer = window.setInterval(() => {
      cursor = Math.min(latestTaskReport.length, cursor + chunk)
      setStreamingSummary(latestTaskReport.slice(0, cursor))
      if (cursor >= latestTaskReport.length) {
        window.clearInterval(timer)
      }
    }, 36)

    return () => window.clearInterval(timer)
  }, [hostNameMap, latestTask?.status, latestTaskId, latestTaskReport, pendingDraft])

  const startVoiceInput = () => {
    if (listening) {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      messageApi.warning('当前浏览器不支持录音上传，请使用 Chrome 或 Edge。')
      return
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        audioChunksRef.current = []
        mediaStreamRef.current = stream
        const recorder = new MediaRecorder(stream)
        mediaRecorderRef.current = recorder
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data)
          }
        }
        recorder.onerror = () => {
          setListening(false)
          setTranscribing(false)
          messageApi.error('录音失败，请重试')
          stream.getTracks().forEach((track) => track.stop())
        }
        recorder.onstop = async () => {
          setListening(false)
          setTranscribing(true)
          stream.getTracks().forEach((track) => track.stop())
          try {
            const mimeType = recorder.mimeType || 'audio/webm'
            const audioBlob = new Blob(audioChunksRef.current, { type: mimeType })
            const result = await transcribeVoice(audioBlob)
            setPrompt(prompt.trim() ? `${prompt.trim()} ${result.text}` : result.text)
            messageApi.success(`语音已由 ${result.model} 转写完成`)
          } catch (error: any) {
            messageApi.error(error?.response?.data?.detail ?? '语音转写失败')
          } finally {
            setTranscribing(false)
            mediaRecorderRef.current = null
            mediaStreamRef.current = null
            audioChunksRef.current = []
          }
        }
        recorder.start()
        setListening(true)
      })
      .catch(() => {
        messageApi.error('无法访问麦克风，请检查浏览器授权')
      })
  }

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const voiceButtonLabel = (() => {
    if (transcribing) return '转写中'
    if (listening) return '停止录音'
    return '语音输入'
  })()

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
              <article
                key={entry.key}
                className={`agent-message agent-message--user${entry.pending ? ' agent-message--pending' : ''}`}
              >
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
              <article key={entry.key} className="agent-output agent-output--pending">
                <div className="agent-output__meta">
                  <Space size={6}>
                    <RobotOutlined />
                    <span>XFusion Agent</span>
                    <Tag color="blue">执行中</Tag>
                  </Space>
                </div>
                <div className="agent-output__surface agent-output__surface--pending">
                  <div className="agent-thinking">
                    <div className="agent-thinking__orb" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="agent-thinking__body">
                      <div className="agent-thinking__phase">
                        <strong>{pendingPhases[pendingPhaseIndex]}</strong>
                        <span>Agent 正在规划、执行和校验，完成后会直接生成富文本结果。</span>
                      </div>
                      <div className="agent-thinking__steps" aria-label="Agent 执行阶段">
                        {pendingPhases.map((phase, index) => (
                          <span
                            key={phase}
                            className={[
                              'agent-thinking__step',
                              index === pendingPhaseIndex ? 'is-active' : '',
                              index < pendingPhaseIndex ? 'is-done' : '',
                            ].filter(Boolean).join(' ')}
                          >
                            {phase}
                          </span>
                        ))}
                      </div>
                      <div className="agent-thinking__skeleton" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            )
          }

          const task = entry.task
          const toolCalls = task.plan_json?.ai?.tool_calls ?? []
          const perHost = task.result_json?.per_host ?? []
          const steps = Array.isArray(task.steps) ? task.steps : []
          const visibleSteps = steps.length
            ? steps
            : [
              {
                step_type: 'analyze',
                title: '生成执行计划',
                status: task.status === 'running' ? 'running' : task.status,
                input_json: { action_type: task.plan_json?.action_type, host_ids: task.target_hosts },
                output_json: { message: task.plan_json?.plan_explanation },
              },
            ]
          const runningStepIndex = getRunningStepIndex(steps)
          const finalReport = buildFallbackReport(task, hostNameMap)
          const visibleReport = task.id === streamingTaskId && streamingSummary
            ? streamingSummary
            : finalReport
          const isStreaming = task.id === streamingTaskId && visibleReport.length < finalReport.length
          const isRunningTask = task.status === 'running'
          return (
            <article
              key={entry.key}
              className={`agent-output agent-output--${task.status}${isStreaming ? ' agent-output--streaming' : ''}`}
            >
              <div className="agent-output__meta">
                <Space size={6}>
                  <RobotOutlined />
                  <span>XFusion Agent</span>
                  <Tag color={getTaskStatusColor(task.status)}>{task.status}</Tag>
                  <span>{formatTimestamp(task.updated_at)}</span>
                </Space>
              </div>
              <div className="agent-output__surface">
                <div className="agent-output__headline">
                  <Typography.Title level={4} style={{ margin: 0 }}>
                    {task.title}
                  </Typography.Title>
                  <Space size={8} wrap>
                    <Tag color="geekblue">{task.plan_json?.ai?.gateway_model ?? activeModel}</Tag>
                    <Tag color="green">{task.target_hosts?.length ?? perHost.length} 台主机</Tag>
                  </Space>
                </div>
                {isRunningTask ? (
                  <div className="agent-running-panel" role="status" aria-live="polite">
                    <span className="agent-running-panel__spinner" aria-hidden="true" />
                    <div className="agent-running-panel__body">
                      <div className="agent-running-panel__topline">
                        <strong>Agent 正在执行任务</strong>
                        <span>
                          {steps.length
                            ? getStepSummary(steps[runningStepIndex])
                            : `正在准备 ${task.plan_json?.action_type ?? task.task_type} 任务。`}
                        </span>
                      </div>
                      <div className="agent-running-panel__progress" aria-hidden="true">
                        <span />
                      </div>
                      <div className="agent-running-panel__steps" aria-label="实时执行步骤">
                        {(steps.length ? steps : runningPhases.map((phase, index) => ({
                          title: phase,
                          status: index === pendingPhaseIndex % runningPhases.length ? 'running' : 'pending',
                          output_json: {},
                        }))).map((step: any, index: number) => (
                          <span
                            key={`${task.id}-running-step-${step.id ?? index}`}
                            className={`agent-running-panel__step is-${step.status}${index === runningStepIndex ? ' is-current' : ''}`}
                            style={{ animationDelay: `${index * 120}ms` }}
                          >
                            <i />
                            <strong>{step.title || step.step_type}</strong>
                            <em>{getStepSummary(step)}</em>
                            <Tag color={getStepStatusColor(step.status)}>{step.status}</Tag>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="agent-process-trace" aria-label="Agent 执行过程">
                  <div className="agent-process-trace__header">
                    <div>
                      <span>AGENT RUN TRACE</span>
                      <strong>执行过程</strong>
                    </div>
                    <Tag color={getTaskStatusColor(task.status)}>{task.status}</Tag>
                  </div>
                  <div className="agent-process-trace__rail">
                    {visibleSteps.map((step: any, index: number) => {
                      const hostRows = getStepHostRows(step, hostNameMap)
                      const meta = getStepMeta(step)
                      const preview = getStepPreview(step)
                      const displayStatus = getDisplayStepStatus(step, task.status, index, visibleSteps)
                      return (
                        <section
                          key={`${task.id}-process-step-${step.id ?? index}`}
                          className={`agent-process-step is-${getStepTone(displayStatus)}`}
                        >
                          <div className="agent-process-step__marker">
                            <span>{index + 1}</span>
                          </div>
                          <div className="agent-process-step__body">
                            <div className="agent-process-step__topline">
                              <div>
                                <em>{getStepPhaseLabel(step.step_type)}</em>
                                <strong>{step.title || step.step_type || 'Agent 步骤'}</strong>
                              </div>
                              <Tag color={getStepStatusColor(displayStatus)}>{getStepStatusLabel(displayStatus)}</Tag>
                            </div>
                            <p>{getStepSummary(step)}</p>
                            {preview ? <small>{preview}</small> : null}
                            {meta.length ? (
                              <div className="agent-process-step__meta">
                                {meta.map((item) => (
                                  <span key={`${step.id ?? index}-${item.label}`}>
                                    {item.label}: <b>{item.value}</b>
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {hostRows.length ? (
                              <div className="agent-process-step__hosts">
                                {hostRows.map((row) => (
                                  <span
                                    key={`${task.id}-${step.id ?? index}-${row.hostName}`}
                                    className={row.success ? 'is-success' : 'is-failed'}
                                    title={row.stderr || undefined}
                                  >
                                    {row.hostName}
                                    <b>{row.success ? '成功' : '失败'}</b>
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                </div>
                <div className="agent-output__richtext">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {ensureMarkdown(visibleReport)}
                  </ReactMarkdown>
                  {isStreaming ? (
                    <span className="agent-output__cursor" aria-hidden="true">▍</span>
                  ) : null}
                </div>
                {(toolCalls.length || perHost.length || steps.length) ? (
                  <details className="agent-output__details">
                    <summary>原始执行数据</summary>
                    <div className="agent-output__details-body">
                      <div className="agent-output__detail-line">
                        <span>任务类型</span>
                        <strong>{task.task_type}</strong>
                      </div>
                      {task.plan_json?.ai?.gateway_model ? (
                        <div className="agent-output__detail-line">
                          <span>模型</span>
                          <strong>{task.plan_json.ai.gateway_model}</strong>
                        </div>
                      ) : null}
                      {toolCalls.length ? (
                        <div className="agent-output__detail-line">
                          <span>工具调用</span>
                          <strong>{toolCalls.length} 次</strong>
                        </div>
                      ) : null}
                      {perHost.length ? (
                        <div className="agent-output__host-results">
                          {perHost.map((item: any, index: number) => (
                            <div key={`${task.id}-host-${index}`} className="agent-output__host-row">
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
            <div className="agent-stage__brand-orb" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              想让 XFusion Agent 处理什么？
            </Typography.Title>
            <Typography.Paragraph className="agent-stage__empty-copy">
              直接描述运维目标。Agent 会结合目标主机、系统状态和工具能力，生成可执行计划并返回结构化结果。
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
        <Input.TextArea
          rows={isIdle ? 3 : 2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault()
              runPrompt()
            }
          }}
          placeholder="尽管问 XFusion Agent，例如：分析这四台服务器里哪一台磁盘压力最大，并给出清理建议。"
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
          <div className="agent-stage__composer-left">
            <Button className="agent-stage__tool-button" shape="circle" icon={<PlusOutlined />} aria-label="添加上下文" />
            <Button
              className="agent-stage__voice-button"
              icon={<AudioOutlined />}
              onClick={startVoiceInput}
              loading={transcribing}
            >
              {voiceButtonLabel}
            </Button>
          </div>
          <div className="agent-stage__composer-right">
            <span className="agent-stage__runtime-pill">{activeModel}</span>
            <span className="agent-stage__target-pill">{selectedHosts.length} 台主机</span>
            <Typography.Text type="secondary" className="agent-stage__target-copy">
              {selectedHostNames.slice(0, 3).join('、') || '未选择主机'}
              {selectedHostNames.length > 3 ? ` 等 ${selectedHostNames.length} 台` : ''}
            </Typography.Text>
          </div>
          <Button
            type="primary"
            shape="circle"
            icon={<PlayCircleOutlined />}
            disabled={!canExecute || Boolean(pendingDraft)}
            loading={dispatching}
            onClick={runPrompt}
            aria-label={pendingDraft ? 'Agent 思考中' : '发送给 Agent'}
            className={`agent-stage__send-button${pendingDraft || dispatching ? ' agent-stage__send-button--sending' : ''}`}
          >
          </Button>
        </div>
      </div>

    </div>
  )
}
