import { AudioOutlined, PlayCircleOutlined, SoundOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  List,
  Select,
  Space,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ExpandablePanelCard } from './ExpandablePanelCard'
import { executeTask, fetchHosts, fetchTask, fetchTasks } from '../services/api'

const quickPrompts = [
  '查询当前磁盘剩余空间',
  '查找 /etc 下面包含 nginx 的文件',
  '22 端口被谁占用了',
  '查询 process:nginx 的进程状态',
  '帮我排查 service:sshd 的状态并给出建议',
]

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

export function AgentPanel() {
  const location = useLocation()
  const [messageApi, contextHolder] = message.useMessage()
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState('console-main')
  const [selectedHosts, setSelectedHosts] = useState<number[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<number>()
  const [routePinnedHostId, setRoutePinnedHostId] = useState<number | null>(null)
  const [listening, setListening] = useState(false)
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
      messageApi.success(`任务已提交，当前状态：${task.status}`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      if (!prompt.trim()) return
      setPrompt('')
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '任务提交失败')
    },
  })

  const hostOptions = useMemo(
    () => hosts.map((host: any) => ({ label: `${host.name} (${host.address})`, value: host.id })),
    [hosts],
  )

  useEffect(() => {
    if (!tasks.length || selectedTaskId) return
    setSelectedTaskId(tasks[0].id)
  }, [tasks, selectedTaskId])

  useEffect(() => {
    const match = location.pathname.match(/^\/hosts\/(\d+)$/)
    if (!match) {
      if (routePinnedHostId !== null) {
        setSelectedHosts((current) =>
          current.length === 1 && current[0] === routePinnedHostId ? [] : current,
        )
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
    return () => {
      window.speechSynthesis?.cancel()
    }
  }, [])

  useEffect(() => {
    window.speechSynthesis?.cancel()
  }, [selectedTaskId])

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
    const summary = currentTask?.result_json?.summary
    if (!summary || !window.speechSynthesis) return
    const utterance = new SpeechSynthesisUtterance(summary)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
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

  const canExecute = Boolean(prompt.trim() && selectedHosts.length)

  return (
    <div className="agent-panel">
      {contextHolder}
      <ExpandablePanelCard
        className="panel-card resizable-card agent-panel__card"
        title={<Typography.Title level={4} style={{ margin: 0 }}>XFusion Agent</Typography.Title>}
        fullscreenLabel="Agent 面板"
        extra={
          <Space wrap>
            <Tag color="geekblue">session {sessionId}</Tag>
            <Tag color="green">{selectedHosts.length} 台目标主机</Tag>
          </Space>
        }
      >
        <div className="panel-card__content">
          <Card type="inner" className="panel-subcard resizable-subcard" title="Agent 上下文">
            <div className="panel-subcard__content">
              <Typography.Text type="secondary">
                右侧常驻会话面板，当前任务执行链路使用 Claude Agent SDK 通过 LiteLLM Gateway 调用上游模型，并完成意图规划与结果解释。
              </Typography.Text>
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
                      items={(currentTask.steps ?? []).slice(-6).map((step: any) => ({
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
                renderItem={(task: any) => (
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
          </Card>
        </div>
      </ExpandablePanelCard>
    </div>
  )
}
