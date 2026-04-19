import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createHost, discoverHost, fetchHosts, profileHost } from '../services/api'

export function HostsPage() {
  const navigate = useNavigate()
  const [messageApi, contextHolder] = message.useMessage()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const queryClient = useQueryClient()

  const { data = [], isLoading } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
  })

  const profileMutation = useMutation({
    mutationFn: profileHost,
    onSuccess: () => {
      messageApi.success('主机画像已刷新')
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })

  const discoverMutation = useMutation({
    mutationFn: discoverHost,
    onSuccess: () => {
      messageApi.success('服务发现已完成')
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })

  const createMutation = useMutation({
    mutationFn: createHost,
    onSuccess: () => {
      messageApi.success('主机已接入')
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      setOpen(false)
      form.resetFields()
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

  return (
    <div className="content-stack">
      {contextHolder}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 className="page-title">主机与服务纳管</h1>
          <p className="page-subtitle">
            支持 SSH / Node Agent / Hybrid 三种接入形态。
          </p>
        </div>
        <Button type="primary" onClick={() => setOpen(true)}>
          新增主机
        </Button>
      </div>

      <Card>
        <Table rowKey="id" loading={isLoading} dataSource={data} columns={columns} pagination={false} />
      </Card>

      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        title="接入主机"
        onOk={() => form.submit()}
        confirmLoading={createMutation.isPending}
      >
        <Form
          layout="vertical"
          form={form}
          onFinish={(values) => createMutation.mutate(values)}
          initialValues={{ connection_mode: 'hybrid', auth_type: 'key', ssh_port: 22, username: 'root' }}
        >
          <Form.Item name="name" label="主机名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="address" label="IP / 域名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="environment" label="环境">
            <Select options={[{ value: 'production' }, { value: 'staging' }, { value: 'dev' }]} />
          </Form.Item>
          <Form.Item name="connection_mode" label="连接模式">
            <Select options={[{ value: 'ssh' }, { value: 'agent' }, { value: 'hybrid' }]} />
          </Form.Item>
          <Form.Item name="auth_type" label="认证方式">
            <Select options={[{ value: 'key' }, { value: 'password' }]} />
          </Form.Item>
          <Form.Item name="username" label="SSH 用户名">
            <Input />
          </Form.Item>
          <Form.Item name="ssh_port" label="SSH 端口">
            <Input type="number" />
          </Form.Item>
          <Form.Item name="ssh_private_key" label="SSH 私钥">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="ssh_password" label="SSH 密码">
            <Input.Password />
          </Form.Item>
          <Form.Item name="agent_url" label="Agent URL">
            <Input placeholder="http://host:9001" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
