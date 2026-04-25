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
  Select,
  Space,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ExpandablePanelCard } from '../components/ExpandablePanelCard'
import type { HostRecord, ProviderInfo, TaskRecord, TaskStepRecord, ValidationItem, ValidationResponse } from '../services/api'
import { executeTask, fetchHosts, fetchPdfValidation, fetchProviders, fetchTask, fetchTasks } from '../services/api'

const examples = [
  '查询当前磁盘剩余空间',
  '查找 /etc 下面包含 nginx 的文件',
  '8080 端口被谁占用了',
  '查询 process:nginx 的进程状态',
  '创建 用户:pdf_verify_user',
  '帮我排查 service:sshd 的状态并给出建议',
]

function parseDfOutput(stdout: string): { filesystem: string; size: string; used: string; avail: string; usePercent: string; mount: string }[] | null {
  const lines = stdout.trim().split('\n')
  if (lines.length < 2 || !lines[0].includes('Mounted') && !lines[0].includes('Filesystem')) return null
  const rows: { filesystem: string; size: string; used: string; avail: string; usePercent: string; mount: string }[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/)
    if (parts.length < 6) continue
    rows.push({ filesystem: parts[0], size: parts[1], used: parts[2], avail: parts[3], usePercent: parts[4], mount: parts.slice(5).join(' ') })
  }
  return rows.length ? rows : null
}

function formatDiskSummary(rows: { filesystem: string; size: string; used: string; avail: string; usePercent: string; mount: string }[]): string {
  const mains = rows.filter(r => r.mount === '/' || r.mount.startsWith('/dev'))
  const target = mains[0] || rows[0]
  if (!target) return ''
  return `磁盘 ${target.mount}：总容量 ${target.size || '?'}，已用 ${target.used || '?'}，可用 ${target.avail || '?'}，使用率 ${target.usePercent}`
}

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

export function TasksPage() {
  const location = useLocation()
  const navigationState = location.state as { selectedHosts?: number[]; sessionId?: string } | null
  const [messageApi, contextHolder] = message.useMessage()
  const [prompt, setPrompt] = useState('查询当前磁盘剩余空间')
  const [sessionId, setSessionId] = useState(() => navigationState?.sessionId ?? 'default')
  const [selectedHosts, setSelectedHosts] = useState<number[]>(() => navigationState?.selectedHosts ?? [])
  const [selectedTaskId, setSelectedTaskId] = useState<number>()
  const [listening, setListening] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined)
  const [customModel, setCustomModel] = useState('')
  const queryClient = useQueryClient()

  const { data: hosts = [] } = useQuery<HostRecord[]>({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
  })

  const { data: providers = [] } = useQuery<ProviderInfo[]>({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    staleTime: 60_000,
  })

  const modelOptions = useMemo(() => {
    return providers
      .filter((p) => p.is_configured && p.models.length > 0)
      .map((p) => ({
        label: p.provider_name,
        options: p.models.map((m) => ({ label: m, value: m })),
      }))
  }, [providers])

  const customModelHints = providers
    .filter((p) => p.is_configured && p.supports_custom_model && p.models.length === 0)
    .map((p) => p.provider_name)

  const { data: tasks = [] } = useQuery<TaskRecord[]>({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
    refetchInterval: 5000,
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

  const { data: validation } = useQuery<ValidationResponse>({
    queryKey: ['pdf-validation'],
    queryFn: fetchPdfValidation,
  })

  const executeMutation = useMutation({
    mutationFn: executeTask,
    onSuccess: (task: TaskRecord) => {
      setSelectedTaskId(task.id)
      messageApi.success(`任务已提交，当前状态：${task.status}`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['pdf-validation'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
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
    window.speechSynthesis?.cancel()
  }, [selectedTaskId])

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
          <ExpandablePanelCard className="panel-card resizable-card tasks-card" title="任务发起与验收" fullscreenLabel="任务发起与验收">
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
                      <Select
                        size="small"
                        allowClear
                        placeholder="默认模型"
                        value={selectedModel}
                        onChange={setSelectedModel}
                        options={modelOptions}
                        style={{ minWidth: 160 }}
                        popupMatchSelectWidth={false}
                      />
                      <Input
                        size="small"
                        placeholder="或输入 provider/model-id"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        style={{ minWidth: 180 }}
                      />
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
                          const resolvedModel = customModel.trim() || selectedModel
                          executeMutation.mutate({
                            prompt,
                            selected_host_ids: selectedHosts,
                            session_id: sessionId,
                            auto_approve: false,
                            model: resolvedModel || null,
                          })
                        }}
                      >
                        执行任务
                      </Button>
                    </div>
                    {customModelHints.length > 0 && (
                      <Typography.Text type="secondary">
                        已配置但需手填模型 ID 的 Provider：{customModelHints.join(' / ')}
                      </Typography.Text>
                    )}
                  </div>
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard tasks-card--validation" title="PDF 验收矩阵">
                <div className="tasks-card__body-scroll">
                  <List
                    dataSource={validation?.items ?? []}
                    renderItem={(item: ValidationItem) => (
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
          </ExpandablePanelCard>
        </section>

        <section className="tasks-board__column tasks-board__column--right">
          <ExpandablePanelCard className="panel-card resizable-card tasks-card" title="执行观察" fullscreenLabel="执行观察">
            <div className="panel-card__content">
              <Card type="inner" className="panel-subcard resizable-subcard tasks-card--timeline" title="任务时间线">
                <div className="tasks-card__body-scroll">
                  <List
                    dataSource={tasks}
                    renderItem={(task: TaskRecord) => (
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
                              {(() => {
                                const ph = (task.result_json?.per_host as Array<{ action_result?: { stdout?: string } }> | undefined)?.[0]
                                const stdout = ph?.action_result?.stdout
                                if (!stdout) return null
                                const dfRows = parseDfOutput(stdout)
                                if (dfRows) {
                                  return (
                                    <div style={{ fontSize: 12 }}>
                                      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 2 }}>
                                        磁盘使用情况：
                                      </Typography.Text>
                                      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                                        <thead>
                                          <tr style={{ background: '#f8fafc' }}>
                                            {['文件系统', '大小', '已用', '可用', '使用率', '挂载点'].map(h => (
                                              <th key={h} style={{ padding: '2px 6px', borderBottom: '1px solid #e2e8f0', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {dfRows.map((r, idx) => (
                                            <tr key={idx}>
                                              <td style={{ padding: '2px 6px' }}>{r.filesystem}</td>
                                              <td style={{ padding: '2px 6px' }}>{r.size}</td>
                                              <td style={{ padding: '2px 6px' }}>{r.used}</td>
                                              <td style={{ padding: '2px 6px' }}>{r.avail}</td>
                                              <td style={{ padding: '2px 6px', color: parseInt(r.usePercent) >= 85 ? '#cf1322' : parseInt(r.usePercent) >= 70 ? '#d48806' : '#389e0d' }}>{r.usePercent}</td>
                                              <td style={{ padding: '2px 6px' }}>{r.mount}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>{formatDiskSummary(dfRows)}</Typography.Text>
                                    </div>
                                  )
                                }
                                return (
                                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, color: '#475569', maxHeight: 120, overflow: 'auto' }}>
                                    {stdout}
                                  </pre>
                                )
                              })()}
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
                      {(() => {
                        const queryActions = new Set(['query_disk', 'query_process', 'check_port', 'search_files'])
                        const actionType = currentTask.plan_json?.action_type as string | undefined
                        if (!actionType || !queryActions.has(actionType)) return null
                        const perHost =
                          (currentTask.result_json?.per_host as Array<{
                            host_name: string
                            action_result?: { stdout?: string; stderr?: string }
                          }> | undefined) ?? []
                        if (!perHost.length) return null
                        return (
                          <Card size="small" title="查询结果">
                            {perHost.map((h, i) => {
                              const stdout = h.action_result?.stdout
                              const dfRows = stdout ? parseDfOutput(stdout) : null
                              return (
                                <div key={i}>
                                  {perHost.length > 1 && (
                                    <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                                      {h.host_name}
                                    </Typography.Text>
                                  )}
                                  {dfRows ? (
                                    <div>
                                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                                        <thead>
                                          <tr style={{ background: '#f8fafc' }}>
                                            {['文件系统', '大小', '已用', '可用', '使用率', '挂载点'].map(hd => (
                                              <th key={hd} style={{ padding: '4px 8px', borderBottom: '1px solid #e2e8f0', textAlign: 'left', fontWeight: 500 }}>{hd}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {dfRows.map((r, idx) => (
                                            <tr key={idx}>
                                              <td style={{ padding: '4px 8px' }}>{r.filesystem}</td>
                                              <td style={{ padding: '4px 8px' }}>{r.size}</td>
                                              <td style={{ padding: '4px 8px' }}>{r.used}</td>
                                              <td style={{ padding: '4px 8px' }}>{r.avail}</td>
                                              <td style={{ padding: '4px 8px', color: parseInt(r.usePercent) >= 85 ? '#cf1322' : parseInt(r.usePercent) >= 70 ? '#d48806' : '#389e0d' }}>{r.usePercent}</td>
                                              <td style={{ padding: '4px 8px' }}>{r.mount}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatDiskSummary(dfRows)}</Typography.Text>
                                    </div>
                                  ) : stdout ? (
                                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 13 }}>{stdout}</pre>
                                  ) : (
                                    <Typography.Text type="secondary">（无输出）</Typography.Text>
                                  )}
                                  {h.action_result?.stderr ? (
                                    <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', color: '#cf1322', fontFamily: 'monospace', fontSize: 13 }}>
                                      {h.action_result.stderr}
                                    </pre>
                                  ) : null}
                                </div>
                              )
                            })}
                          </Card>
                        )
                      })()}
                      <Card size="small" title="AI 计划">
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                          {JSON.stringify(currentTask.plan_json, null, 2)}
                        </pre>
                      </Card>
                      <Card size="small" title="执行步骤">
                        <Timeline
                          items={(currentTask.steps ?? []).map((step: TaskStepRecord) => ({
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
          </ExpandablePanelCard>
        </section>
      </div>
    </div>
  )
}
