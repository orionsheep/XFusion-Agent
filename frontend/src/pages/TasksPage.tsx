import { AudioOutlined, PlayCircleOutlined, SoundOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  List,
  Space,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { executeTask, fetchHosts, fetchPdfValidation, fetchTask, fetchTasks } from '../services/api'

const examples = [
  '查询当前磁盘剩余空间',
  '查找 /etc 下面包含 nginx 的文件',
  '8080 端口被谁占用了',
  '查询 process:nginx 的进程状态',
  '创建 用户:pdf_verify_user',
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

export function TasksPage() {
  const location = useLocation()
  const [messageApi, contextHolder] = message.useMessage()
  const [prompt, setPrompt] = useState('查询当前磁盘剩余空间')
  const [sessionId, setSessionId] = useState('default')
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
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.status
      return !status || ['running', 'waiting_approval'].includes(status) ? 3000 : false
    },
  })

  const { data: validation } = useQuery({
    queryKey: ['pdf-validation'],
    queryFn: fetchPdfValidation,
  })

  const executeMutation = useMutation({
    mutationFn: executeTask,
    onSuccess: (task) => {
      setSelectedTaskId(task.id)
      messageApi.success(`任务已提交，当前状态：${task.status}`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['pdf-validation'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
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
    if (!tasks.length || selectedTaskId) {
      return
    }
    setSelectedTaskId(tasks[0].id)
  }, [tasks, selectedTaskId])

  useEffect(() => {
    const state = location.state as { selectedHosts?: number[]; sessionId?: string } | null
    if (!state) return
    if (state.selectedHosts?.length) {
      setSelectedHosts(state.selectedHosts)
    }
    if (state.sessionId) {
      setSessionId(state.sessionId)
    }
  }, [location.state])

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
        messageApi.success('语音输入已写入任务框')
      }
    }
    recognition.start()
  }

  const speakSummary = () => {
    const summary = currentTask?.result_json?.summary
    if (!summary || !window.speechSynthesis) {
      return
    }
    const utterance = new SpeechSynthesisUtterance(summary)
    utterance.lang = 'zh-CN'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }

  const canExecute = Boolean(prompt.trim() && selectedHosts.length)

  return (
    <div className="tasks-page">
      {contextHolder}
      <div className="tasks-page__intro">
        <h1 className="page-title">Goal-driven 任务中心</h1>
        <p className="page-subtitle">
          由中央 Claude Agent 做意图规划、连续任务分析、风险解释和结果总结。
        </p>
      </div>

      <Alert
        className="tasks-page__notice"
        type="info"
        message="当前任务中心已对齐 PDF 要求：自然语言驱动、风险审批、多步排障、过程留痕，以及可选语音输入。"
      />

      <div className="tasks-board">
        <section className="tasks-board__column tasks-board__column--left">
          <Card className="panel-card resizable-card tasks-card" title="任务发起与验收">
            <div className="panel-card__content">
              <Card type="inner" className="panel-subcard resizable-subcard tasks-card--composer" title="发起任务">
                <div className="tasks-card__body-scroll">
                  <div className="task-composer">
                    <div className="task-composer__section task-composer__section--muted">
                      <Typography.Text strong>目标主机</Typography.Text>
                      <Checkbox.Group
                        className="task-composer__host-grid"
                        options={hostOptions}
                        value={selectedHosts}
                        onChange={(values) => setSelectedHosts(values as number[])}
                      />
                    </div>

                    <div className="task-composer__section task-composer__section--muted">
                      <Typography.Text strong>会话上下文</Typography.Text>
                      <Input
                        value={sessionId}
                        onChange={(event) => setSessionId(event.target.value)}
                        placeholder="会话 ID，用于多轮上下文"
                      />
                    </div>

                    <div className="task-composer__section">
                      <Typography.Text strong>任务目标</Typography.Text>
                      <Input.TextArea
                        rows={7}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder="例如：帮我排查 service:sshd 为什么启动失败"
                      />
                      <Space wrap>
                        {examples.map((item) => (
                          <Tag
                            key={item}
                            style={{ cursor: 'pointer', padding: '6px 10px' }}
                            onClick={() => setPrompt(item)}
                          >
                            {item}
                          </Tag>
                        ))}
                      </Space>
                    </div>

                    <div className="task-composer__footer">
                      <Button icon={<AudioOutlined />} onClick={startVoiceInput} loading={listening}>
                        {listening ? '正在听写' : '语音输入'}
                      </Button>
                      <Button
                        type="primary"
                        icon={<PlayCircleOutlined />}
                        disabled={!canExecute}
                        loading={executeMutation.isPending}
                        onClick={() => {
                          if (!prompt.trim()) {
                            messageApi.warning('先输入任务目标')
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
                        }}
                      >
                        执行任务
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard tasks-card--validation" title="PDF 验收矩阵">
                <div className="tasks-card__body-scroll">
                  <List
                    dataSource={validation?.items ?? []}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta
                          title={item.requirement}
                          description={item.evidence}
                        />
                        <Tag color={item.status === 'pass' ? 'green' : 'gold'}>{item.status}</Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>
            </div>
          </Card>
        </section>

        <section className="tasks-board__column tasks-board__column--right">
          <Card className="panel-card resizable-card tasks-card" title="执行观察">
            <div className="panel-card__content">
              <Card type="inner" className="panel-subcard resizable-subcard tasks-card--timeline" title="任务时间线">
                <div className="tasks-card__body-scroll">
                  <List
                    dataSource={tasks}
                    renderItem={(task: any) => (
                      <List.Item
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <List.Item.Meta
                          title={
                            <Space wrap>
                              <Typography.Text strong>{task.title}</Typography.Text>
                              <Tag>{task.task_type}</Tag>
                              <Tag color="blue">{task.risk_level}</Tag>
                            </Space>
                          }
                          description={
                            <Space direction="vertical" size={2}>
                              <Typography.Text type="secondary">{task.prompt}</Typography.Text>
                              <Typography.Text type="secondary">Goal: {task.goal}</Typography.Text>
                              {task.result_json?.summary ? (
                                <Typography.Text>{task.result_json.summary}</Typography.Text>
                              ) : null}
                            </Space>
                          }
                        />
                        <Tag color={getTaskStatusColor(task.status)}>{task.status}</Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>

              <Card
                type="inner"
                className="panel-subcard resizable-subcard tasks-card--detail"
                title={currentTask ? `任务详情 #${currentTask.id}` : '任务详情'}
                extra={
                  currentTask?.result_json?.summary ? (
                    <Button icon={<SoundOutlined />} onClick={speakSummary}>
                      语音播报结论
                    </Button>
                  ) : null
                }
              >
                <div className="tasks-card__body-scroll">
                  {!currentTask ? (
                    <Empty description="选择一条任务查看 AI 计划与执行步骤" />
                  ) : (
                    <Space direction="vertical" style={{ width: '100%' }} size={16}>
                      <Alert
                        type={getTaskAlertType(currentTask.status)}
                        message={currentTask.result_json?.summary ?? currentTask.plan_json?.plan_explanation ?? '任务执行中'}
                      />
                      <Card size="small" title="AI 计划">
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                          {JSON.stringify(currentTask.plan_json, null, 2)}
                        </pre>
                      </Card>
                      <Card size="small" title="执行步骤">
                        <Timeline
                          items={(currentTask.steps ?? []).map((step: any) => ({
                            color:
                              step.status === 'failed' ? 'red' : step.status === 'pending' ? 'gold' : 'green',
                            children: (
                              <Space direction="vertical" size={4}>
                                <Typography.Text strong>
                                  {step.step_type} · {step.title}
                                </Typography.Text>
                                <Typography.Text type="secondary">{step.status}</Typography.Text>
                                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                                  {JSON.stringify(step.output_json, null, 2)}
                                </pre>
                              </Space>
                            ),
                          }))}
                        />
                      </Card>
                    </Space>
                  )}
                </div>
              </Card>
            </div>
          </Card>
        </section>
      </div>
    </div>
  )
}
