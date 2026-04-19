import { AudioOutlined, PlayCircleOutlined, SoundOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  List,
  Row,
  Space,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { executeTask, fetchHosts, fetchPdfValidation, fetchTask, fetchTasks } from '../services/api'

const examples = [
  '查询当前磁盘剩余空间',
  '查找 /etc 下面包含 nginx 的文件',
  '8080 端口被谁占用了',
  '查询 process:nginx 的进程状态',
  '创建 用户:pdf_verify_user',
  '帮我排查 service:sshd 的状态并给出建议',
]

export function TasksPage() {
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
    refetchInterval: 3000,
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

  return (
    <div className="content-stack">
      {contextHolder}
      <div>
        <h1 className="page-title">Goal-driven 任务中心</h1>
        <p className="page-subtitle">
          由中央 Claude Agent 做意图规划、连续任务分析、风险解释和结果总结。
        </p>
      </div>

      <Alert
        type="info"
        message="当前任务中心已对齐 PDF 要求：自然语言驱动、风险审批、多步排障、过程留痕，以及可选语音输入。"
      />

      <Row gutter={16}>
        <Col xs={24} xl={9}>
          <Card title="发起任务">
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              <Checkbox.Group
                options={hostOptions}
                value={selectedHosts}
                onChange={(values) => setSelectedHosts(values as number[])}
              />
              <Input
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
                placeholder="会话 ID，用于多轮上下文"
              />
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
              <Space>
                <Button icon={<AudioOutlined />} onClick={startVoiceInput} loading={listening}>
                  {listening ? '正在听写' : '语音输入'}
                </Button>
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  loading={executeMutation.isPending}
                  onClick={() =>
                    executeMutation.mutate({
                      prompt,
                      selected_host_ids: selectedHosts,
                      session_id: sessionId,
                      auto_approve: false,
                    })
                  }
                >
                  执行任务
                </Button>
              </Space>
            </Space>
          </Card>

          <Card title="PDF 验收矩阵">
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
          </Card>
        </Col>

        <Col xs={24} xl={15}>
          <Card title="任务时间线">
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
                  <Tag
                    color={
                      task.status === 'succeeded'
                        ? 'green'
                        : task.status === 'waiting_approval'
                          ? 'gold'
                          : task.status === 'failed'
                            ? 'red'
                            : 'blue'
                    }
                  >
                    {task.status}
                  </Tag>
                </List.Item>
              )}
            />
          </Card>

          <Card
            title={currentTask ? `任务详情 #${currentTask.id}` : '任务详情'}
            extra={
              currentTask?.result_json?.summary ? (
                <Button icon={<SoundOutlined />} onClick={speakSummary}>
                  语音播报结论
                </Button>
              ) : null
            }
          >
            {!currentTask ? (
              <Empty description="选择一条任务查看 AI 计划与执行步骤" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={16}>
                <Alert
                  type={currentTask.status === 'failed' ? 'error' : currentTask.status === 'waiting_approval' ? 'warning' : 'success'}
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
          </Card>
        </Col>
      </Row>
    </div>
  )
}
