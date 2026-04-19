import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login } from '../services/api'

export function LoginPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

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
          width: 460,
          borderRadius: 24,
          background: 'rgba(255,255,255,0.82)',
          border: '1px solid rgba(15,23,42,0.08)',
        }}
      >
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={2} style={{ marginBottom: 8 }}>
              登录 XFusion Agent
            </Typography.Title>
            <Typography.Paragraph style={{ color: '#64748b', marginBottom: 0 }}>
              默认开发账号：`admin / admin123`
            </Typography.Paragraph>
          </div>
          {error ? <Alert type="error" message={error} /> : null}
          <Form
            layout="vertical"
            onFinish={async (values) => {
              try {
                setLoading(true)
                setError(undefined)
                await login(values.username, values.password)
                navigate('/')
              } catch (err) {
                setError('登录失败，请检查用户名和密码')
              } finally {
                setLoading(false)
              }
            }}
            initialValues={{ username: 'admin', password: 'admin123' }}
          >
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
              <Input prefix={<UserOutlined />} size="large" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password prefix={<LockOutlined />} size="large" />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={loading}>
              进入控制台
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  )
}
