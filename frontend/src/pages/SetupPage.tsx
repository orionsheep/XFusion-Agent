import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { bootstrapAdmin, fetchAuthStatus } from '../services/api'

export function SetupPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const { data: authStatus, isLoading } = useQuery({
    queryKey: ['auth-status'],
    queryFn: fetchAuthStatus,
    retry: false,
  })

  useEffect(() => {
    if (authStatus?.initialized) {
      navigate('/login', { replace: true })
    }
  }, [authStatus, navigate])

  if (isLoading || authStatus?.initialized) {
    return null
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <Card
        style={{
          width: 520,
          background: 'rgba(255,255,255,0.82)',
          border: '1px solid rgba(15,23,42,0.08)',
        }}
      >
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={2} style={{ marginBottom: 8 }}>
              初始化管理员账号
            </Typography.Title>
            <Typography.Paragraph style={{ color: '#64748b', marginBottom: 0 }}>
              这是系统第一次启动。先创建一个管理员账号，后续所有运维账号都由管理员在系统设置里统一管理。
            </Typography.Paragraph>
          </div>
          {error ? <Alert type="error" message={error} /> : null}
          <Form
            layout="vertical"
            onFinish={async (values) => {
              if (values.password !== values.confirmPassword) {
                setError('两次输入的密码不一致')
                return
              }
              try {
                setLoading(true)
                setError(undefined)
                await bootstrapAdmin(values.username, values.password)
                navigate('/')
              } catch (err: any) {
                setError(err?.response?.data?.detail ?? '管理员初始化失败')
              } finally {
                setLoading(false)
              }
            }}
          >
            <Form.Item
              name="username"
              label="管理员账号"
              rules={[{ required: true }, { min: 3, message: '至少 3 个字符' }]}
            >
              <Input prefix={<UserOutlined />} size="large" />
            </Form.Item>
            <Form.Item
              name="password"
              label="管理员密码"
              rules={[{ required: true }, { min: 8, message: '至少 8 个字符' }]}
            >
              <Input.Password prefix={<LockOutlined />} size="large" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="确认密码"
              rules={[{ required: true }, { min: 8, message: '至少 8 个字符' }]}
            >
              <Input.Password prefix={<SafetyCertificateOutlined />} size="large" />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={loading}>
              创建管理员并进入控制台
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  )
}
