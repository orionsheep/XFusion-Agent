import {
  AudioOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  SoundOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Select,
  Space,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ExpandablePanelCard } from './ExpandablePanelCard'
import {
  executeTask,
  fetchHosts,
  fetchRuntimeLlmProfile,
  fetchTask,
  fetchTasks,
} from '../services/api'

const quickPrompts = [
  '查询当前磁盘剩余空间',
  '查找 /etc 下面包含 nginx 的文件',
  '22 端口被谁占用了',
  '查询 process:nginx 的进程状态',
  '帮我排查 service:sshd 的状态并给出建议',
]

const SESSION_STORAGE_KEY = 'xfusion_agent_session_id'
const HOSTS_STORAGE_KEY = 'xfusion_agent_selected_hosts'

function getTaskStatusColor(status: string) {
  if (status === 'succeeded') return 'green'
  if (status === 'waiting_approval') return 'gold'
  if (status === 'failed') return 'red'
  return 'blue'
}

function getTaskAlertType(status?: string): 'success' | 'info' | 'warning' | 'error' {
  if (status === 'failed') return 'error'
  if (status === 'waiting_approval') return 'warning'
  if (status === 'succeeded') return 'success'
  return 'info'
}

function buildSessionId() {
  return `agent-${Date.now().toString(36)}`
}

function getStoredSessionId() {
  if (typeof window === 'undefined') return buildSessionId()
  const stored = window.localStorage.getItem(SESSION_STORAGE_KEY)
  if (!stored || stored === 'console-main') return buildSessionId()
  return stored
}

function getStoredSelectedHosts() {
  if (typeof window === 'undefined') return [] as number[]
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HOSTS_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value) => Number.isFinite(value)) : []
  } catch {
    return []
  }
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

export function AgentPanel() {
  const location = useLocation()
  const [messageApi, contextHolder] = message.useMessage()
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState(getStoredSessionId)
  const [selectedHosts, setSelectedHosts] = useState<number[]>(getStoredSelectedHosts)
  const [selectedTaskId, setSelectedTaskId] = useState<number>()
  const [routePinnedHostId, setRoutePinnedHostId] = useState<number | null>(null)
  const [listening, setListening] = useState(false)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()

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

  const { data: currentTask } = useQuery({
    queryKey: ['task', selectedTaskId],
    queryFn: () => fetchTask(Number(selectedTaskId)),
    enabled: Boolean(selectedTaskId),
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.status
      return !status || ['running', 'waiting_approval'].includes(status) ? 3000 : false
    },
  })

  const executeMutation = useMutation({
    mutationFn: executeTask,
    onSuccess: (task) => {
      setSelectedTaskId(task.id)
      messageApi.success(`Agent 已提交任务，当前状态：${task.status}`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      setPrompt('')
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? 'Agent 任务提交失败')
    },
  })

  const hostOptions = useMemo(
    () => hosts.map((host: any) => ({ label: `${host.name} (${host.address})`, value: host.id })),
    [hosts],
  )

  const hostNameMap = useMemo(
    () => new Map(hosts.map((host: any) => [host.id, host.name])),
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

  const latestSessionTask = currentTask && currentTask.session_id === sessionId
    ? currentTask
    : sessionTasks.at(-1)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  }, [sessionId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(selectedHosts))
  }, [selectedHosts])

  useEffect(() => {
    if (!tasks.length) return
    if (!selectedTaskId || !sessionTasks.some((task: any) => task.id === selectedTaskId)) {
      setSelectedTaskId(sessionTasks.at(-1)?.id)
    }
  }, [tasks, sessionTasks, selectedTaskId])

  useEffect(() => {
    const match = location.pathname.match(/^\/hosts\/(\d+)$/)
    if (!match) {
      if (routePinnedHostId !== null) {
        setRoutePinnedHostId(null)
      }
      return
    }
    const hostId = Number(match[1])
    if (Number.isFinite(hostId)) {
      setSelectedHosts([hostId])
      setRoutePinnedHostId(hostId)
    }
  }, [location.pathname, routePinnedHostId])

  useEffect(() => {
    if (!hosts.length || selectedHosts.length || routePinnedHostId !== null) return
    setSelectedHosts(hosts.map((host: any) => host.id))
  }, [hosts, routePinnedHostId, selectedHosts.length])

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel()
    }
  }, [])

  useEffect(() => {
    window.speechSynthesis?.cancel()
  }, [selectedTaskId])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const node = conversationRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sessionTasks.length, executeMutation.isPending])

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
        messageApi.success('语音输入已写入 Agent 输入框')
      }
    }
    recognition.start()
  }

  const speakSummary = () => {
    const summary = latestSessionTask?.result_json?.summary
    if (!summary || !window.speechSynthesis) return
    const utterance = new SpeechSynthesisUtterance(summary)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  const createNewConversation = () => {
    const nextSessionId = buildSessionId()
    setSessionId(nextSessionId)
    setSelectedTaskId(undefined)
    setPrompt('')
    messageApi.success('已创建新的 Agent 会话')
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
    executeMutation.mutate({
      prompt,
      selected_host_ids: selectedHosts,
      session_id: sessionId,
      auto_approve: false,
    })
  }

  const conversationEntries = useMemo(() => {
    const entries: Array<{ type: 'user' | 'assistant'; key: string; task?: any; prompt?: string; pending?: boolean }> = []
    sessionTasks.slice(-16).forEach((task: any) => {
      entries.push({ type: 'user', key: `user-${task.id}`, task })
      entries.push({ type: 'assistant', key: `assistant-${task.id}`, task })
    })
    const pendingPrompt = (executeMutation.variables as any)?.prompt
    if (executeMutation.isPending && pendingPrompt) {
      entries.push({ type: 'user', key: 'pending-user', prompt: pendingPrompt, pending: true })
      entries.push({ type: 'assistant', key: 'pending-assistant', pending: true })
    }
    return entries
  }, [executeMutation.isPending, executeMutation.variables, sessionTasks])

  const canExecute = Boolean(prompt.trim() && selectedHosts.length)
  const selectedHostNames = selectedHosts.map((hostId) => hostNameMap.get(hostId) ?? `host-${hostId}`)

  return (
    <div className="agent-panel">
      {contextHolder}
      <ExpandablePanelCard
        className="panel-card resizable-card agent-panel__card"
        title={<Typography.Title level={4} style={{ margin: 0 }}>XFusion Agent</Typography.Title>}
        fullscreenLabel="Agent 面板"
        extra={(
          <Space wrap size={6}>
            <Tag color="geekblue">{activeModel}</Tag>
            <Tag color="green">{selectedHosts.length} 台目标主机</Tag>
          </Space>
        )}
      >
        <div className="panel-card__content agent-panel__content">
          <div className="agent-panel__hero">
            <div className="agent-panel__hero-copy">
              <Typography.Text className="page-kicker">Agent Console</Typography.Text>
              <Typography.Title level={3} style={{ margin: 0 }}>
                让 Agent 直接驱动运维任务
              </Typography.Title>
              <Typography.Paragraph style={{ margin: 0, color: '#64748b' }}>
                右侧是主对话面板。输入目标后，Agent 会基于当前会话上下文、主机选择和 Claude SDK Gateway 模型完成规划与执行。
              </Typography.Paragraph>
            </div>
            <Space wrap size={8}>
              <Tag color="blue">会话 {sessionId}</Tag>
              {routePinnedHostId ? <Tag color="cyan">已锁定当前主机</Tag> : null}
              <Button size="small" icon={<PlusOutlined />} onClick={createNewConversation}>
                新对话
              </Button>
            </Space>
          </div>

          <div className="agent-panel__shell">
            <section className="agent-panel__chat-column">
              <Card type="inner" className="panel-subcard resizable-subcard agent-panel__conversation-card" title="Agent 对话">
                <div ref={conversationRef} className="panel-subcard__content agent-panel__conversation">
                  {conversationEntries.length ? conversationEntries.map((entry) => {
                    if (entry.type === 'user') {
                      const taskHosts = (entry.task?.target_hosts as number[] | undefined) ?? selectedHosts
                      return (
                        <div key={entry.key} className="agent-bubble agent-bubble--user">
                          <div className="agent-bubble__meta">
                            <Space size={6}>
                              <UserOutlined />
                              <span>你</span>
                              <span>{formatTimestamp(entry.task?.created_at) || (entry.pending ? '发送中' : '')}</span>
                            </Space>
                          </div>
                          <div className="agent-bubble__body">
                            <Typography.Paragraph style={{ marginBottom: 0 }}>
                              {entry.prompt ?? entry.task?.prompt}
                            </Typography.Paragraph>
                            <Space wrap size={6} style={{ marginTop: 10 }}>
                              {taskHosts.slice(0, 6).map((hostId) => (
                                <Tag key={`${entry.key}-${hostId}`}>
                                  {String(hostNameMap.get(hostId) ?? `host-${hostId}`)}
                                </Tag>
                              ))}
                            </Space>
                          </div>
                        </div>
                      )
                    }

                    if (entry.pending) {
                      return (
                        <div key={entry.key} className="agent-bubble agent-bubble--assistant agent-bubble--pending">
                          <div className="agent-bubble__meta">
                            <Space size={6}>
                              <RobotOutlined />
                              <span>XFusion Agent</span>
                              <span>正在规划与执行</span>
                            </Space>
                          </div>
                          <div className="agent-bubble__body">
                            <Typography.Paragraph style={{ marginBottom: 0 }}>
                              正在连接目标主机、生成计划并执行任务，请稍候。
                            </Typography.Paragraph>
                          </div>
                        </div>
                      )
                    }

                    const task = entry.task
                    return (
                      <div key={entry.key} className="agent-bubble agent-bubble--assistant">
                        <div className="agent-bubble__meta">
                          <Space size={6}>
                            <RobotOutlined />
                            <span>XFusion Agent</span>
                            <Tag color={getTaskStatusColor(task.status)}>{task.status}</Tag>
                            <span>{formatTimestamp(task.updated_at)}</span>
                          </Space>
                        </div>
                        <div className="agent-bubble__body">
                          <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 10 }}>
                            {task.title}
                          </Typography.Title>
                          <Typography.Paragraph style={{ marginBottom: 0 }}>
                            {task.result_json?.summary ?? task.plan_json?.plan_explanation ?? '任务已提交，等待结果。'}
                          </Typography.Paragraph>
                          <Space wrap size={6} style={{ marginTop: 12 }}>
                            <Tag color="blue">{task.task_type}</Tag>
                            <Tag color="purple">{task.risk_level}</Tag>
                            {task.plan_json?.ai?.gateway_model ? <Tag color="geekblue">{task.plan_json.ai.gateway_model}</Tag> : null}
                            {task.plan_json?.ai?.used_ai_planning ? <Tag color="green">AI 规划</Tag> : null}
                            <Button type="link" size="small" onClick={() => setSelectedTaskId(task.id)}>
                              查看细节
                            </Button>
                          </Space>
                        </div>
                      </div>
                    )
                  }) : (
                    <Empty
                      description="从右下角输入一个目标。这里会按对话流展示你的请求和 Agent 返回。"
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  )}
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard agent-panel__composer-card" title="发送给 Agent">
                <div className="panel-subcard__content agent-panel__composer">
                  <Input.TextArea
                    rows={5}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onPressEnter={(event) => {
                      if (!event.shiftKey) {
                        event.preventDefault()
                        runPrompt()
                      }
                    }}
                    placeholder="直接给 Agent 一个目标，例如：帮我检查所有服务器的磁盘、内存和高占用进程，并告诉我最危险的一台。"
                  />
                  <Space wrap size={[8, 8]}>
                    {quickPrompts.map((item) => (
                      <Tag
                        key={item}
                        className="agent-panel__quick-tag"
                        onClick={() => setPrompt(item)}
                      >
                        {item}
                      </Tag>
                    ))}
                  </Space>
                  <div className="agent-panel__composer-footer">
                    <div className="agent-panel__composer-note">
                      <Typography.Text type="secondary">
                        当前目标：{selectedHostNames.slice(0, 3).join('、') || '未选择主机'}
                        {selectedHostNames.length > 3 ? ` 等 ${selectedHostNames.length} 台` : ''}
                      </Typography.Text>
                    </div>
                    <Space>
                      <Button icon={<AudioOutlined />} onClick={startVoiceInput} loading={listening}>
                        {listening ? '正在听写' : '语音输入'}
                      </Button>
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
                  </div>
                </div>
              </Card>
            </section>

            <aside className="agent-panel__rail">
              <Card type="inner" className="panel-subcard resizable-subcard agent-panel__rail-card" title="会话与目标">
                <div className="panel-subcard__content">
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="选择目标主机"
                    options={hostOptions}
                    value={selectedHosts}
                    onChange={(values) => {
                      setSelectedHosts(values)
                      setRoutePinnedHostId(null)
                    }}
                    maxTagCount="responsive"
                  />
                  <Input
                    value={sessionId}
                    onChange={(event) => setSessionId(event.target.value || buildSessionId())}
                    placeholder="会话 ID"
                  />
                  <Alert
                    type="info"
                    showIcon
                    message={`当前模型：${activeModel}`}
                    description="你可以在系统设置里切换上游模型，新任务会直接使用新的模型配置。"
                  />
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard agent-panel__rail-card" title="当前任务">
                <div className="panel-subcard__content">
                  {latestSessionTask ? (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type={getTaskAlertType(latestSessionTask.status)}
                        showIcon
                        message={latestSessionTask.result_json?.summary ?? latestSessionTask.plan_json?.plan_explanation ?? '任务执行中'}
                      />
                      <div>
                        <Typography.Text strong>{latestSessionTask.title}</Typography.Text>
                        <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
                          {latestSessionTask.prompt}
                        </Typography.Paragraph>
                      </div>
                      <Space wrap size={6}>
                        <Tag color="blue">{latestSessionTask.task_type}</Tag>
                        <Tag color="purple">{latestSessionTask.risk_level}</Tag>
                        {latestSessionTask.plan_json?.ai?.gateway_provider ? (
                          <Tag color="geekblue">{latestSessionTask.plan_json.ai.gateway_provider}</Tag>
                        ) : null}
                        {latestSessionTask.result_json?.summary ? (
                          <Button type="link" size="small" icon={<SoundOutlined />} onClick={speakSummary}>
                            语音播报
                          </Button>
                        ) : null}
                      </Space>
                      <Timeline
                        items={(currentTask?.steps ?? []).slice(-5).map((step: any) => ({
                          color: step.status === 'failed' ? 'red' : step.status === 'pending' ? 'gold' : 'green',
                          children: (
                            <Space direction="vertical" size={2}>
                              <Typography.Text strong>{step.step_type}</Typography.Text>
                              <Typography.Text type="secondary">{step.title}</Typography.Text>
                            </Space>
                          ),
                        }))}
                      />
                    </Space>
                  ) : (
                    <Empty description="当前会话还没有任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  )}
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard agent-panel__rail-card" title="本会话最近消息">
                <div className="panel-subcard__content agent-panel__session-list">
                  {sessionTasks.length ? sessionTasks.slice(-8).reverse().map((task: any) => (
                    <button
                      key={task.id}
                      type="button"
                      className={`agent-session-item${task.id === latestSessionTask?.id ? ' is-active' : ''}`}
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      <div className="agent-session-item__title">
                        <span>{task.title}</span>
                        <Tag color={getTaskStatusColor(task.status)}>{task.status}</Tag>
                      </div>
                      <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>
                        {task.prompt}
                      </Typography.Paragraph>
                    </button>
                  )) : (
                    <Empty description="发送第一条消息后，会话记录会出现在这里。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  )}
                </div>
              </Card>
            </aside>
          </div>
        </div>
      </ExpandablePanelCard>
    </div>
  )
}
