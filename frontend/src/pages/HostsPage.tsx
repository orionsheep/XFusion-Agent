import {
  ApiOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExpandablePanelCard } from '../components/ExpandablePanelCard'
import { createHost, discoverHost, fetchHosts, profileHost } from '../services/api'

const connectionModeOptions = [
  {
    value: 'ssh',
    label: 'SSH',
    subtitle: '远程命令通道',
    description: '适合快速接入已有服务器，不需要安装节点 Agent。',
    icon: <KeyOutlined />,
  },
  {
    value: 'agent',
    label: 'Node Agent',
    subtitle: '节点本地采集',
    description: '适合长期监控、低延迟采样和本地任务执行。',
    icon: <DeploymentUnitOutlined />,
  },
  {
    value: 'hybrid',
    label: 'Hybrid',
    subtitle: 'Agent 优先，SSH 兜底',
    description: '生产推荐模式，兼顾实时采集、远程控制和故障兜底。',
    icon: <CloudServerOutlined />,
  },
]

const modeLabelMap = Object.fromEntries(connectionModeOptions.map((item) => [item.value, item.label]))

export function HostsPage() {
  const navigate = useNavigate()
  const [messageApi, contextHolder] = message.useMessage()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const connectionMode = Form.useWatch('connection_mode', form)
  const authType = Form.useWatch('auth_type', form)
  const queryClient = useQueryClient()
  const needsSsh = connectionMode !== 'agent'
  const needsAgent = connectionMode !== 'ssh'

  useEffect(() => {
    if (!needsAgent) {
      form.setFieldValue('agent_url', undefined)
    }
    if (!needsSsh) {
      form.setFieldsValue({
        ssh_private_key: undefined,
        ssh_password: undefined,
      })
      return
    }
    if (authType === 'key') {
      form.setFieldValue('ssh_password', undefined)
    }
    if (authType === 'password') {
      form.setFieldValue('ssh_private_key', undefined)
    }
  }, [authType, form, needsAgent, needsSsh])

  const { data = [], isLoading } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
  })

  const profileMutation = useMutation({
    mutationFn: profileHost,
    onSuccess: () => {
      messageApi.success('主机画像已刷新')
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '主机画像刷新失败')
    },
  })

  const discoverMutation = useMutation({
    mutationFn: discoverHost,
    onSuccess: () => {
      messageApi.success('服务发现已完成')
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '服务发现失败')
    },
  })

  const createMutation = useMutation({
    mutationFn: createHost,
    onSuccess: () => {
      messageApi.success('主机已接入')
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
      setOpen(false)
      form.resetFields()
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '主机接入失败')
    },
  })

  const columns = useMemo(
    () => [
      {
        title: '主机',
        dataIndex: 'name',
        render: (_: unknown, record: any) => (
          <Space direction="vertical" size={2}>
            <Typography.Link onClick={() => navigate(`/hosts/${record.id}`)}>
              {record.name}
            </Typography.Link>
            <Typography.Text type="secondary">{record.address}</Typography.Text>
          </Space>
        ),
      },
      {
        title: '连接模式',
        dataIndex: 'connection_mode',
        render: (value: string) => <Tag color="cyan">{value}</Tag>,
      },
      {
        title: '系统',
        render: (_: unknown, record: any) =>
          `${record.os_type ?? 'unknown'} ${record.os_version ?? ''}`.trim(),
      },
      {
        title: '状态',
        dataIndex: 'status',
        render: (value: string) => (
          <Tag color={value === 'online' || value === 'registered' ? 'green' : 'default'}>{value}</Tag>
        ),
      },
      {
        title: '操作',
        render: (_: unknown, record: any) => (
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => profileMutation.mutate(record.id)}>
              Profiling
            </Button>
            <Button icon={<SearchOutlined />} onClick={() => discoverMutation.mutate(record.id)}>
              Discover
            </Button>
          </Space>
        ),
      },
    ],
    [discoverMutation, navigate, profileMutation],
  )

  const stats = useMemo(() => {
    const byMode = {
      ssh: data.filter((host: any) => host.connection_mode === 'ssh').length,
      agent: data.filter((host: any) => host.connection_mode === 'agent').length,
      hybrid: data.filter((host: any) => host.connection_mode === 'hybrid').length,
    }
    const online = data.filter((host: any) => ['online', 'registered'].includes(host.status)).length
    return { byMode, online, total: data.length }
  }, [data])

  return (
    <div className="page-shell">
      {contextHolder}
      <div className="page-shell__header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <h1 className="page-title">主机与服务纳管</h1>
            <p className="page-subtitle">
              支持 SSH / Node Agent / Hybrid 三种接入形态。
            </p>
          </div>
          <Button type="primary" className="host-add-button" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            新增主机
          </Button>
        </div>
      </div>

      <div className="page-shell__body">
        <ExpandablePanelCard className="panel-card resizable-card" title="纳管工作台" fullscreenLabel="纳管工作台">
          <div className="panel-card__content">
            <div className="panel-subgrid panel-subgrid--2">
              <Card type="inner" className="panel-subcard resizable-subcard" title="接入策略">
                <div className="panel-subcard__content">
                  <Typography.Text>SSH：远程命令通道</Typography.Text>
                  <Typography.Text>Node Agent：节点本地执行与采集</Typography.Text>
                  <Typography.Text>Hybrid：Agent 为主，SSH 兜底</Typography.Text>
                </div>
              </Card>
              <Card type="inner" className="panel-subcard resizable-subcard" title="纳管概览">
                <div className="panel-subcard__content">
                  <Space wrap>
                    <Tag color="green">在线 {stats.online}</Tag>
                    <Tag>总主机 {stats.total}</Tag>
                    <Tag color="cyan">SSH {stats.byMode.ssh}</Tag>
                    <Tag color="blue">Agent {stats.byMode.agent}</Tag>
                    <Tag color="purple">Hybrid {stats.byMode.hybrid}</Tag>
                  </Space>
                </div>
              </Card>
            </div>

            <Card type="inner" className="panel-subcard resizable-subcard" title="主机列表">
              <div className="panel-subcard__content">
                <div className="table-scroll">
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    dataSource={data}
                    columns={columns}
                    pagination={false}
                    scroll={{ x: 980 }}
                  />
                </div>
              </div>
            </Card>
          </div>
        </ExpandablePanelCard>
      </div>

      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        title={null}
        footer={null}
        width={900}
        className="host-onboarding-modal"
        confirmLoading={createMutation.isPending}
      >
        <div className="host-onboarding__hero">
          <span className="host-onboarding__hero-icon"><CloudServerOutlined /></span>
          <div>
            <span className="host-onboarding__eyebrow">HOST ONBOARDING</span>
            <h2>接入目标主机</h2>
            <p>把远程服务器加入 XFusion Agent，后续可用于资源监控、服务发现、数据库盘点和 AI 运维任务。</p>
          </div>
          <span className="host-onboarding__mode-pill">
            {modeLabelMap[connectionMode || 'hybrid'] ?? 'Hybrid'}
          </span>
        </div>
        <Form
          layout="vertical"
          form={form}
          className="host-onboarding-form"
          onFinish={(values) => createMutation.mutate(values)}
          initialValues={{ connection_mode: 'hybrid', auth_type: 'key', ssh_port: 22, username: 'root' }}
        >
          <section className="host-onboarding__section">
            <div className="host-onboarding__section-head">
              <span>01</span>
              <div>
                <h3>基础信息</h3>
                <p>先定义主机身份，名称建议使用业务语义，例如 `prod-api-01`。</p>
              </div>
            </div>
            <div className="host-onboarding__grid host-onboarding__grid--2">
              <Form.Item name="name" label="主机名称" rules={[{ required: true, message: '请输入主机名称' }]}>
                <Input placeholder="prod-api-01" />
              </Form.Item>
              <Form.Item name="address" label="IP / 域名" rules={[{ required: true, message: '请输入 IP 或域名' }]}>
                <Input placeholder="192.168.1.10 或 example.internal" />
              </Form.Item>
              <Form.Item name="environment" label="环境">
                <Select
                  options={[
                    { value: 'production', label: 'Production' },
                    { value: 'staging', label: 'Staging' },
                    { value: 'dev', label: 'Development' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="risk_level" label="默认风险级别">
                <Select
                  options={[
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                  ]}
                />
              </Form.Item>
            </div>
            <Form.Item name="labels" label="标签">
              <Select
                mode="tags"
                placeholder="例如：database、web、gpu、prod"
                tokenSeparators={[',', ' ']}
              />
            </Form.Item>
          </section>

          <section className="host-onboarding__section">
            <div className="host-onboarding__section-head">
              <span>02</span>
              <div>
                <h3>接入模式</h3>
                <p>Hybrid 更适合生产环境；如果暂时没有节点 Agent，可以先用 SSH 接入。</p>
              </div>
            </div>
            <Form.Item name="connection_mode" rules={[{ required: true }]}>
              <Radio.Group className="host-mode-grid">
                {connectionModeOptions.map((option) => (
                  <Radio.Button key={option.value} value={option.value} className="host-mode-card">
                    <span className="host-mode-card__icon">{option.icon}</span>
                    <span className="host-mode-card__body">
                      <strong>{option.label}</strong>
                      <small>{option.subtitle}</small>
                      <em>{option.description}</em>
                    </span>
                  </Radio.Button>
                ))}
              </Radio.Group>
            </Form.Item>
          </section>

          {needsSsh ? (
            <section className="host-onboarding__section host-onboarding__section--secure">
              <div className="host-onboarding__section-head">
                <span>03</span>
                <div>
                  <h3>SSH 认证</h3>
                  <p>凭据只写入本地运行数据库并会脱敏进入审计日志，不会被提交到 GitHub。</p>
                </div>
              </div>
              <Form.Item name="auth_type" label="认证方式" rules={[{ required: true }]}>
                <Radio.Group className="host-auth-grid">
                  <Radio.Button value="key" className="host-auth-card">
                    <KeyOutlined />
                    <span>
                      <strong>SSH 私钥</strong>
                      <small>推荐方式</small>
                    </span>
                  </Radio.Button>
                  <Radio.Button value="password" className="host-auth-card">
                    <LockOutlined />
                    <span>
                      <strong>SSH 密码</strong>
                      <small>临时接入</small>
                    </span>
                  </Radio.Button>
                </Radio.Group>
              </Form.Item>
              <div className="host-onboarding__grid host-onboarding__grid--2">
                <Form.Item name="username" label="SSH 用户名" rules={[{ required: true, message: '请输入 SSH 用户名' }]}>
                  <Input placeholder="root" />
                </Form.Item>
                <Form.Item name="ssh_port" label="SSH 端口" rules={[{ required: true, message: '请输入 SSH 端口' }]}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </div>
              {authType === 'key' ? (
                <Form.Item
                  name="ssh_private_key"
                  label="SSH 私钥"
                  rules={[{ required: true, message: 'SSH key 模式下必须提供私钥' }]}
                >
                  <Input.TextArea rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                </Form.Item>
              ) : null}
              {authType === 'password' ? (
                <Form.Item
                  name="ssh_password"
                  label="SSH 密码"
                  rules={[{ required: true, message: 'SSH password 模式下必须提供密码' }]}
                >
                  <Input.Password placeholder="请输入 SSH 密码" />
                </Form.Item>
              ) : null}
            </section>
          ) : null}
          {needsAgent ? (
            <section className="host-onboarding__section">
              <div className="host-onboarding__section-head">
                <span>{needsSsh ? '04' : '03'}</span>
                <div>
                  <h3>Node Agent 通道</h3>
                  <p>用于节点本地执行、系统指标采集和后续长任务协同。</p>
                </div>
              </div>
              <Form.Item
                name="agent_url"
                label="Agent URL"
                rules={[{ required: true, message: 'Agent / Hybrid 模式下必须提供 Agent URL' }]}
              >
                <Input prefix={<ApiOutlined />} placeholder="http://host:9001" />
              </Form.Item>
            </section>
          ) : null}
          <div className="host-onboarding__footer">
            <span><SafetyCertificateOutlined /> 接入后会自动触发主机画像、服务发现和风险审计。</span>
            <Space>
              <Button onClick={() => setOpen(false)}>取消</Button>
              <Button type="primary" loading={createMutation.isPending} onClick={() => form.submit()}>
                接入主机
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </div>
  )
}
