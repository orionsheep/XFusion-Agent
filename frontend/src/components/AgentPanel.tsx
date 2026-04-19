import { AudioOutlined, PlayCircleOutlined, SoundOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
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
import { executeTask, fetchHosts, fetchTask, fetchTasks } from '../services/api'

const quickPrompts = [
  '查询当前磁盘剩余空间',
  '查找 /etc 下面包含 nginx 的文件',
  '22 端口被谁占用了',
  '查询 process:nginx 的进程状态',
  '帮我排查 service:sshd 的状态并给出建议',
]

export function AgentPanel() {
  const location = useLocation()
  const [messageApi, contextHolder] = message.useMessage()
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState('console-main')
  const [selectedHosts, setSelectedHosts] = useState<number[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<number>()
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
    refetchInterval: 3000,
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
    if (!match) return
    const hostId = Number(match[1])
    if (Number.isFinite(hostId)) {
      setSelectedHosts([hostId])
    }
  }, [location.pathname])

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

  return (
    <div className="agent-panel">
      {contextHolder}
      <div className="agent-panel__header">
        <div>
          <div className="page-kicker">Agent</div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            XFusion Agent
          </Typography.Title>
          <Typography.Text type="secondary">
            右侧常驻会话面板，当前任务执行链路使用 Claude Agent SDK 做意图规划与结果解释。
          </Typography.Text>
        </div>
        <Space wrap>
          <Tag color="geekblue">session {sessionId}</Tag>
          <Tag color="green">{selectedHosts.length} 台目标主机</Tag>
        </Space>
      </div>

      <div className="agent-panel__context">
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Select
            mode="multiple"
            allowClear
            placeholder="选择目标主机"
            options={hostOptions}
            value={selectedHosts}
            onChange={(values) => setSelectedHosts(values)}
            maxTagCount="responsive"
          />
          <Input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="会话 ID，用于连续对话上下文"
          />
        </Space>
      </div>

      <div className="agent-panel__body">
        {currentTask ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <Alert
              type={currentTask.status === 'failed' ? 'error' : currentTask.status === 'waiting_approval' ? 'warning' : 'success'}
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

        <div className="agent-panel__section">
          <Typography.Text strong>近期任务</Typography.Text>
          <List
            style={{ marginTop: 12 }}
            dataSource={tasks.slice(0, 8)}
            locale={{ emptyText: '暂无历史任务' }}
            renderItem={(task: any) => (
              <List.Item
                style={{ cursor: 'pointer', paddingInline: 0 }}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <List.Item.Meta
                  title={task.title}
                  description={
                    <Typography.Text type="secondary">
                      {task.prompt}
                    </Typography.Text>
                  }
                />
                <Tag color={task.status === 'succeeded' ? 'green' : task.status === 'waiting_approval' ? 'gold' : task.status === 'failed' ? 'red' : 'blue'}>
                  {task.status}
                </Tag>
              </List.Item>
            )}
          />
        </div>
      </div>

      <div className="agent-panel__composer">
        <Input.TextArea
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="直接给 Agent 一个目标，例如：帮我检查 server-4 的磁盘和高占用进程"
        />
        <Space wrap style={{ marginTop: 12 }}>
          {quickPrompts.map((item) => (
            <Tag key={item} style={{ cursor: 'pointer', padding: '6px 10px' }} onClick={() => setPrompt(item)}>
              {item}
            </Tag>
          ))}
        </Space>
        <Space style={{ marginTop: 12, width: '100%', justifyContent: 'space-between' }}>
          <Button icon={<AudioOutlined />} onClick={startVoiceInput} loading={listening}>
            {listening ? '正在听写' : '语音输入'}
          </Button>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={executeMutation.isPending} onClick={runPrompt}>
            发送给 Agent
          </Button>
        </Space>
      </div>
    </div>
  )
}
