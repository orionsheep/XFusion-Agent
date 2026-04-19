import { PlayCircleOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Input,
  List,
  Row,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { useMemo, useState } from 'react'
import { executeTask, fetchHosts, fetchTasks } from '../services/api'

export function TasksPage() {
  const [messageApi, contextHolder] = message.useMessage()
  const [prompt, setPrompt] = useState('查询当前磁盘剩余空间')
  const [selectedHosts, setSelectedHosts] = useState<number[]>([])
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

  const executeMutation = useMutation({
    mutationFn: executeTask,
    onSuccess: (task) => {
      messageApi.success(`任务已提交，当前状态：${task.status}`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const hostOptions = useMemo(
    () => hosts.map((host: any) => ({ label: `${host.name} (${host.address})`, value: host.id })),
    [hosts],
  )

  return (
    <div className="content-stack">
      {contextHolder}
      <div>
        <h1 className="page-title">Goal-driven 任务中心</h1>
        <p className="page-subtitle">
          由中央 Claude Agent 编排，目标、成功标准、审批和审计全部留痕。
        </p>
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={10}>
          <Card title="发起任务">
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              <Alert
                type="info"
                message="先选目标主机，再输入自然语言目标。系统会以 goal-driven 模式生成 Goal 与 Criteria。"
              />
              <Checkbox.Group
                options={hostOptions}
                value={selectedHosts}
                onChange={(values) => setSelectedHosts(values as number[])}
              />
              <Input.TextArea
                rows={6}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="例如：帮我排查 service:sshd 为什么启动失败"
              />
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={executeMutation.isPending}
                onClick={() =>
                  executeMutation.mutate({
                    prompt,
                    selected_host_ids: selectedHosts,
                    session_id: 'default',
                    auto_approve: false,
                  })
                }
              >
                执行任务
              </Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title="任务时间线">
            <List
              dataSource={tasks}
              renderItem={(task: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        <Typography.Text strong>{task.title}</Typography.Text>
                        <Tag>{task.task_type}</Tag>
                        <Tag color="blue">{task.risk_level}</Tag>
                      </Space>
                    }
                    description={
                      <Space direction="vertical" size={2}>
                        <Typography.Text type="secondary">{task.prompt}</Typography.Text>
                        <Typography.Text type="secondary">Goal: {task.goal}</Typography.Text>
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
        </Col>
      </Row>
    </div>
  )
}
