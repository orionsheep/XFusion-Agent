import {
  AudioOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Drawer,
  Input,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
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

export function AgentPanel() {
  const [messageApi, contextHolder] = message.useMessage()
  const [listening, setListening] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [pendingDraft, setPendingDraft] = useState<{
    prompt: string
    hostIds: number[]
  } | null>(null)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()
  const {
    prompt,
    setPrompt,
    sessionId,
    selectedHosts,
    setSelectedHosts,
    routePinnedHostId,
    setRoutePinnedHostId,
    drawerOpen,
    setDrawerOpen,
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

      <div className="agent-stage__hero window-drag-handle">
        <div>
          <Typography.Text className="page-kicker">LIVE AGENT CONSOLE</Typography.Text>
          <Typography.Title level={2} style={{ margin: '8px 0 4px' }}>
            直接用 Agent 驱动运维任务
          </Typography.Title>
          <Typography.Paragraph style={{ margin: 0 }}>
            参考 Kimi 的极简对话首页和 MiniMax 的品牌节奏，当前界面只保留最必要的对话、执行反馈和输入主轴。
          </Typography.Paragraph>
        </div>
        <div className="agent-stage__hero-meta">
          <span>{selectedHosts.length} 台目标主机</span>
          <strong>{activeModel}</strong>
        </div>
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
                    正在连接目标主机、拉取上下文、生成计划并执行任务。
                  </Typography.Paragraph>
                </div>
              </article>
            )
          }

          const task = entry.task
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
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  {task.result_json?.summary ?? task.plan_json?.plan_explanation ?? '任务已提交，等待结果。'}
                </Typography.Paragraph>
                <Space wrap size={6} style={{ marginTop: 10 }}>
                  <Tag color="blue">{task.task_type}</Tag>
                  {task.plan_json?.ai?.gateway_model ? <Tag color="geekblue">{task.plan_json.ai.gateway_model}</Tag> : null}
                  {task.plan_json?.ai?.tool_calls?.length ? <Tag color="green">{task.plan_json.ai.tool_calls.length} 次工具调用</Tag> : null}
                </Space>
              </div>
            </article>
          )
        }) : (
          <div className="agent-stage__empty">
            <div className="agent-stage__empty-orb" />
            <Typography.Title level={3} style={{ margin: 0 }}>
              告诉 Agent 你要达成什么目标
            </Typography.Title>
            <Typography.Paragraph className="agent-stage__empty-copy">
              从一句自然语言开始。Agent 会结合当前主机上下文、模型配置和工具能力，自己规划并返回结果。
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
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault()
              runPrompt()
            }
          }}
          placeholder="直接告诉 Agent 你要做什么，例如：分析这四台服务器里哪一台磁盘压力最大，并给出清理建议。"
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
        <div className="agent-stage__composer-row">
          <div className="agent-stage__composer-status">
            <Tag color="geekblue">{activeModel}</Tag>
            <Tag color="green">{selectedHosts.length} 台主机</Tag>
          </div>
          <Typography.Text type="secondary">
            当前目标：{selectedHostNames.slice(0, 3).join('、') || '未选择主机'}
            {selectedHostNames.length > 3 ? ` 等 ${selectedHostNames.length} 台` : ''}
          </Typography.Text>
        </div>
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

      <Drawer
        title="会话设置"
        placement="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={360}
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
            {routePinnedHostId ? <Tag color="cyan">当前会话锁定到单台主机</Tag> : null}
          </div>

          <div className="agent-drawer__section">
            <Typography.Text strong>当前会话</Typography.Text>
            <Input value={sessionId} readOnly />
            <Typography.Text type="secondary">新对话会生成新的会话上下文。</Typography.Text>
          </div>

          <div className="agent-drawer__section">
            <Typography.Text strong>当前模型</Typography.Text>
            <Tag color="geekblue">{activeModel}</Tag>
            <Typography.Text type="secondary">模型自由切换入口位于系统设置。</Typography.Text>
          </div>
        </div>
      </Drawer>
    </div>
  )
}
