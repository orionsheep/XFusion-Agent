import {
  AudioOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Tag,
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
  fetchTasks,
} from '../services/api'

const quickPrompts = [
  '查询当前磁盘剩余空间',
  '查找 /etc 下面包含 nginx 的文件',
  '22 端口被谁占用了',
  '查询 process:nginx 的进程状态',
]

const SESSION_STORAGE_KEY = 'xfusion_agent_session_id'
const HOSTS_STORAGE_KEY = 'xfusion_agent_selected_hosts'

function getTaskStatusColor(status: string) {
  if (status === 'succeeded') return 'green'
  if (status === 'waiting_approval') return 'gold'
  if (status === 'failed') return 'red'
  return 'blue'
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
  const [routePinnedHostId, setRoutePinnedHostId] = useState<number | null>(null)
  const [listening, setListening] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [pendingDraft, setPendingDraft] = useState<{
    prompt: string
    hostIds: number[]
  } | null>(null)
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

  const latestSessionTask = sessionTasks.at(-1)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  }, [sessionId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(selectedHosts))
  }, [selectedHosts])

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
    }
  }, [pendingDraft, sessionTasks])

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

  const speakLatestSummary = () => {
    const summary = latestSessionTask?.result_json?.summary
    if (!summary || !window.speechSynthesis) return
    const utterance = new SpeechSynthesisUtterance(summary)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  const createNewConversation = () => {
    setSessionId(buildSessionId())
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
    const entries: Array<{ type: 'user' | 'assistant'; key: string; task?: any; prompt?: string; pending?: boolean }> = []
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
            <Button size="small" icon={<SettingOutlined />} onClick={() => setDrawerOpen(true)}>
              会话设置
            </Button>
            <Button size="small" icon={<PlusOutlined />} onClick={createNewConversation}>
              新对话
            </Button>
          </Space>
        )}
      >
        <div className="panel-card__content agent-panel__content agent-panel__content--minimal">
          <Card type="inner" className="panel-subcard resizable-subcard agent-panel__conversation-card" title="Agent 对话">
            <div ref={conversationRef} className="panel-subcard__content agent-panel__conversation">
              {conversationEntries.length ? conversationEntries.map((entry) => {
                if (entry.type === 'user') {
                  const taskHosts = (entry.task?.target_hosts as number[] | undefined)
                    ?? (entry.pending ? pendingDraft?.hostIds : selectedHosts)
                    ?? selectedHosts
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
                          {taskHosts.slice(0, 4).map((hostId) => (
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
                      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
                        {task.title}
                      </Typography.Title>
                      <Typography.Paragraph style={{ marginBottom: 0 }}>
                        {task.result_json?.summary ?? task.plan_json?.plan_explanation ?? '任务已提交，等待结果。'}
                      </Typography.Paragraph>
                      <Space wrap size={6} style={{ marginTop: 10 }}>
                        <Tag color="blue">{task.task_type}</Tag>
                        {task.plan_json?.ai?.gateway_model ? <Tag color="geekblue">{task.plan_json.ai.gateway_model}</Tag> : null}
                      </Space>
                    </div>
                  </div>
                )
              }) : (
                <Empty
                  description="直接输入一个目标。这里只保留会话消息，不再堆叠其他不必要的信息。"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              )}
            </div>
          </Card>

          <Card type="inner" className="panel-subcard resizable-subcard agent-panel__composer-card" title="发送给 Agent">
            <div className="panel-subcard__content agent-panel__composer">
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
                placeholder="直接告诉 Agent 你要做什么，例如：帮我检查所有服务器里哪一台最危险。"
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
                <Typography.Text type="secondary">
                  当前目标：{selectedHostNames.slice(0, 3).join('、') || '未选择主机'}
                  {selectedHostNames.length > 3 ? ` 等 ${selectedHostNames.length} 台` : ''}
                </Typography.Text>
                <Space>
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
                    {pendingDraft ? 'Agent 处理中' : '发送给 Agent'}
                  </Button>
                </Space>
              </div>
            </div>
          </Card>
        </div>
      </ExpandablePanelCard>
      <Drawer
        title="会话设置"
        placement="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={340}
      >
        <div className="agent-drawer">
          <div className="agent-drawer__section">
            <Typography.Text strong>目标主机</Typography.Text>
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
            {routePinnedHostId ? <Tag color="cyan">已锁定当前主机</Tag> : null}
          </div>

          <div className="agent-drawer__section">
            <Typography.Text strong>当前会话</Typography.Text>
            <Input value={sessionId} readOnly />
            <Typography.Text type="secondary">新对话会生成新的会话上下文。</Typography.Text>
          </div>

          <div className="agent-drawer__section">
            <Typography.Text strong>当前模型</Typography.Text>
            <Tag color="geekblue">{activeModel}</Tag>
            <Typography.Text type="secondary">模型切换入口在系统设置页面。</Typography.Text>
          </div>

          {latestSessionTask ? (
            <div className="agent-drawer__section">
              <Typography.Text strong>当前任务</Typography.Text>
              <div className="agent-drawer__task">
                <Typography.Text strong>{latestSessionTask.title}</Typography.Text>
                <Typography.Paragraph style={{ margin: '6px 0 0' }}>
                  {latestSessionTask.result_json?.summary ?? latestSessionTask.plan_json?.plan_explanation ?? '任务已提交，等待结果。'}
                </Typography.Paragraph>
                <Space wrap size={6}>
                  <Tag color={getTaskStatusColor(latestSessionTask.status)}>{latestSessionTask.status}</Tag>
                  {latestSessionTask.plan_json?.ai?.gateway_model ? (
                    <Tag color="blue">{latestSessionTask.plan_json.ai.gateway_model}</Tag>
                  ) : null}
                  {latestSessionTask.result_json?.summary ? (
                    <Button size="small" type="text" onClick={speakLatestSummary}>
                      语音播报
                    </Button>
                  ) : null}
                </Space>
              </div>
            </div>
          ) : null}
        </div>
      </Drawer>
    </div>
  )
}
