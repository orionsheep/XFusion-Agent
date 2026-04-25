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
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ExpandablePanelCard } from './ExpandablePanelCard'
import type { HostRecord, ProviderInfo, TaskRecord, TaskStepRecord } from '../services/api'
import { executeTask, fetchHosts, fetchProviders, fetchTask, fetchTasks } from '../services/api'

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

type SpeechRecognitionResultEvent = {
  results?: ArrayLike<ArrayLike<{ transcript?: string }>>
}

type SpeechRecognitionInstance = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null
  start: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

export function AgentPanel() {
  const [messageApi, contextHolder] = message.useMessage()
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState('console-main')
  const [selectedHosts, setSelectedHosts] = useState<number[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<number>()
  const [listening, setListening] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined)
  const [customModel, setCustomModel] = useState('')
  const queryClient = useQueryClient()
  const isTasksRoute = location.pathname === '/tasks'
  const pinnedHostId = useMemo(() => {
    const match = location.pathname.match(/^\/hosts\/(\d+)$/)
    if (!match) {
      return null
    }
    const hostId = Number(match[1])
    return Number.isFinite(hostId) ? hostId : null
  }, [location.pathname])
  const effectiveSelectedHosts = pinnedHostId !== null ? [pinnedHostId] : selectedHosts

  const { data: providers = [] } = useQuery<ProviderInfo[]>({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    staleTime: 60_000,
  })

  const modelOptions = useMemo(() => {
    const configured = providers.filter((p) => p.is_configured && p.models.length > 0)
    return configured.map((p) => ({
      label: p.provider_name,
      options: p.models.map((m) => ({ label: m, value: m })),
    }))
  }, [providers])

  const { data: hosts = [] } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
    staleTime: 60_000,
  })
  const { data: tasks = [] } = useQuery<TaskRecord[]>({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
    enabled: isTasksRoute,
    refetchInterval: isTasksRoute ? 5000 : false,
  })
  const activeTaskId = selectedTaskId ?? tasks[0]?.id
  const { data: currentTask } = useQuery<TaskRecord>({
    queryKey: ['task', activeTaskId],
    queryFn: () => fetchTask(Number(activeTaskId)),
    enabled: Boolean(activeTaskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return !status || ['running', 'waiting_approval'].includes(status) ? 3000 : false
    },
  })

  const executeMutation = useMutation({
    mutationFn: executeTask,
    onSuccess: (task: TaskRecord) => {
      setSelectedTaskId(task.id)
      messageApi.success(`任务已提交，当前状态：${task.status}`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      setPendingDraft(null)
      setDispatching(false)
      setPrompt('')
    },
    onError: (error: unknown) => {
      const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      messageApi.error(detail ?? '任务提交失败')
    },
  })

  const hostOptions = useMemo(
    () => hosts.map((host: HostRecord) => ({ label: `${host.name} (${host.address})`, value: host.id })),
    [hosts],
  )

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
    if (streamedTaskRef.current === latestTaskId) return
    streamedTaskRef.current = latestTaskId
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
  }, [hostNameMap, latestTaskId, latestTaskReport, pendingDraft])

  const startVoiceInput = () => {
    const recognitionWindow = window as Window & {
      SpeechRecognition?: SpeechRecognitionConstructor
      webkitSpeechRecognition?: SpeechRecognitionConstructor
    }
    const Recognition = recognitionWindow.SpeechRecognition || recognitionWindow.webkitSpeechRecognition
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
    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
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
    if (!effectiveSelectedHosts.length) {
      messageApi.warning('至少选择一台目标主机')
      return
    }
    const resolvedModel = customModel.trim() || selectedModel
    executeMutation.mutate({
      prompt,
      selected_host_ids: effectiveSelectedHosts,
      session_id: sessionId,
      auto_approve: false,
      model: resolvedModel || null,
    })
  }

  const customModelHints = providers
    .filter((provider) => provider.is_configured && provider.supports_custom_model && provider.models.length === 0)
    .map((provider) => provider.provider_name)
  const canExecute = Boolean(prompt.trim() && effectiveSelectedHosts.length)

  return (
    <div className={`agent-stage window-draggable${isIdle ? ' agent-stage--idle' : ''}${pendingDraft ? ' agent-stage--busy' : ''}`}>
      {contextHolder}
      <ExpandablePanelCard
        className="panel-card resizable-card agent-panel__card"
        title={<Typography.Title level={4} style={{ margin: 0 }}>XFusion Agent</Typography.Title>}
        fullscreenLabel="Agent 面板"
        extra={
          <Space wrap>
            <Tag color="geekblue">session {sessionId}</Tag>
            <Tag color="green">{effectiveSelectedHosts.length} 台目标主机</Tag>
          </Space>
        }
      >
        <div className="panel-card__content">
          <Card type="inner" className="panel-subcard resizable-subcard" title="Agent 上下文">
            <div className="panel-subcard__content">
              <Typography.Text type="secondary">
                右侧常驻会话面板，当前任务执行链路使用 Claude Agent SDK 做意图规划与结果解释。
              </Typography.Text>
              <Select
                mode="multiple"
                allowClear
                placeholder="选择目标主机"
                options={hostOptions}
                value={effectiveSelectedHosts}
                disabled={pinnedHostId !== null}
                onChange={(values) => setSelectedHosts(values)}
                maxTagCount="responsive"
              />
              {pinnedHostId !== null ? (
                <Typography.Text type="secondary">当前从主机详情页进入，目标主机已锁定。</Typography.Text>
              ) : null}
              <Input
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
                placeholder="会话 ID，用于连续对话上下文"
              />
            </div>
          </Card>

          <Card type="inner" className="panel-subcard resizable-subcard agent-panel__subcard--live" title="当前观察">
            <div className="panel-subcard__content">
              {currentTask ? (
                <Space direction="vertical" style={{ width: '100%' }} size={16}>
                  <Alert
                    type={getTaskAlertType(currentTask.status)}
                    message={currentTask.result_json?.summary ?? currentTask.plan_json?.plan_explanation ?? '任务执行中'}
                    showIcon
                  />
                  <div className="agent-panel__section">
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Typography.Text strong>最近执行</Typography.Text>
                      {currentTask?.result_json?.summary ? (
                        <Button type="link" icon={<SoundOutlined />} onClick={speakSummary}>
                          语音播报
                        </Button>
                      ) : null}
                    </Space>
                    <Typography.Title level={5} style={{ marginTop: 12 }}>
                      {currentTask.title}
                    </Typography.Title>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                      {currentTask.prompt}
                    </Typography.Paragraph>
                    <Space wrap style={{ marginTop: 12 }}>
                      <Tag color="blue">{currentTask.task_type}</Tag>
                      <Tag color="purple">{currentTask.risk_level}</Tag>
                      <Tag color={currentTask.plan_json?.ai?.used_ai_planning ? 'green' : 'default'}>
                        {currentTask.plan_json?.ai?.used_ai_planning ? 'Claude 规划' : '回退规划'}
                      </Tag>
                    </Space>
                  </div>

                  <div className="agent-panel__section">
                    <Typography.Text strong>执行时间线</Typography.Text>
                    <Timeline
                      style={{ marginTop: 12 }}
                      items={(currentTask.steps ?? []).slice(-6).map((step: TaskStepRecord) => ({
                        color: step.status === 'failed' ? 'red' : step.status === 'pending' ? 'gold' : 'green',
                        children: (
                          <Space direction="vertical" size={2}>
                            <Typography.Text strong>{step.step_type}</Typography.Text>
                            <Typography.Text type="secondary">{step.title}</Typography.Text>
                          </Space>
                        ),
                      }))}
                    />
                  </div>
                </Space>
              ) : (
                <Empty description="发送一个任务给右侧 Agent，结果会持续留在这里。" />
              )}
            </div>
          </Card>

          <Card type="inner" className="panel-subcard resizable-subcard agent-panel__subcard--history" title="近期任务">
            <div className="panel-subcard__content">
              <List
                dataSource={tasks.slice(0, 8)}
                locale={{ emptyText: '暂无历史任务' }}
                renderItem={(task: TaskRecord) => (
                  <List.Item
                    style={{ cursor: 'pointer', paddingInline: 0 }}
                    onClick={() => setSelectedTaskId(task.id)}
                  >
                    <List.Item.Meta
                      title={task.title}
                      description={<Typography.Text type="secondary">{task.prompt}</Typography.Text>}
                    />
                    <Tag color={getTaskStatusColor(task.status)}>{task.status}</Tag>
                  </List.Item>
                )}
              />
            </div>
          </Card>

          <Card type="inner" className="panel-subcard resizable-subcard agent-panel__subcard--composer" title="Agent 输入">
            <div className="panel-subcard__content">
              <Input.TextArea
                rows={4}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="直接给 Agent 一个目标，例如：帮我检查 server-4 的磁盘和高占用进程"
              />
              <Space wrap>
                {quickPrompts.map((item) => (
                  <Tag key={item} style={{ cursor: 'pointer', padding: '6px 10px' }} onClick={() => setPrompt(item)}>
                    {item}
                  </Tag>
                ))}
              </Space>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Button icon={<AudioOutlined />} onClick={startVoiceInput} loading={listening}>
                  {listening ? '正在听写' : '语音输入'}
                </Button>
                <Space>
                  <Select
                    size="small"
                    allowClear
                    placeholder="默认模型"
                    value={selectedModel}
                    onChange={setSelectedModel}
                    options={modelOptions}
                    style={{ width: 200 }}
                    popupMatchSelectWidth={false}
                  />
                  <Input
                    size="small"
                    placeholder="或输入 provider/model-id"
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    style={{ width: 220 }}
                  />
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    disabled={!canExecute}
                    loading={executeMutation.isPending}
                    onClick={runPrompt}
                  >
                    发送给 Agent
                  </Button>
                </Space>
              </Space>
              {customModelHints.length ? (
                <Typography.Text type="secondary">
                  已配置但需手填模型 ID 的 Provider：{customModelHints.join(' / ')}
                </Typography.Text>
              ) : null}
            </div>
          </Card>
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
              <article key={entry.key} className="agent-output agent-output--pending">
                <div className="agent-output__meta">
                  <Space size={6}>
                    <RobotOutlined />
                    <span>XFusion Agent</span>
                    <Tag color="blue">执行中</Tag>
                  </Space>
                </div>
                <div className="agent-output__surface agent-output__surface--pending">
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
          const finalReport = buildFallbackReport(task, hostNameMap)
          const visibleReport = task.id === streamingTaskId && streamingSummary
            ? streamingSummary
            : finalReport
          return (
            <article key={entry.key} className={`agent-output agent-output--${task.status}`}>
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
                <div className="agent-output__richtext">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {ensureMarkdown(visibleReport)}
                  </ReactMarkdown>
                  {task.id === streamingTaskId && visibleReport.length < finalReport.length ? (
                    <span className="agent-output__cursor" aria-hidden="true">▍</span>
                  ) : null}
                </div>
                {(toolCalls.length || perHost.length) ? (
                  <details className="agent-output__details">
                    <summary>执行细节</summary>
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
