import {
  AuditOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  PoweroffOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Avatar, Button, Layout, Menu, Space, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { clearStoredToken } from '../services/api'

const { Header, Sider, Content } = Layout

const items = [
  { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/hosts', icon: <DeploymentUnitOutlined />, label: '主机与服务' },
  { key: '/tasks', icon: <PoweroffOutlined />, label: '任务中心' },
  { key: '/approvals', icon: <SafetyCertificateOutlined />, label: '审批中心' },
  { key: '/audit', icon: <AuditOutlined />, label: '审计日志' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
]

export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={260}
        theme="light"
        style={{
          borderRight: '1px solid rgba(15, 23, 42, 0.08)',
          background: 'rgba(255,255,255,0.72)',
          backdropFilter: 'blur(16px)',
        }}
      >
        <div style={{ padding: 24 }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            XFusion Agent
          </Typography.Title>
          <Typography.Paragraph style={{ margin: '8px 0 0', color: '#64748b' }}>
            Goal-driven AI 运维控制平面
          </Typography.Paragraph>
        </div>
        <Menu
          selectedKeys={[location.pathname]}
          items={items}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none', background: 'transparent' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: 'transparent',
            padding: '16px 24px 0',
            height: 'auto',
          }}
        >
          <div
            style={{
              background: 'rgba(255,255,255,0.78)',
              border: '1px solid rgba(15,23,42,0.08)',
              borderRadius: 18,
              padding: '14px 18px',
            }}
          >
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <div>
                <Typography.Text strong>全量版控制台</Typography.Text>
                <div style={{ color: '#64748b' }}>
                  Claude Agent SDK + SSH/Node Agent + 审批审计
                </div>
              </div>
              <Space>
                <Avatar style={{ backgroundColor: '#0f766e' }}>A</Avatar>
                <Button
                  onClick={() => {
                    clearStoredToken()
                    navigate('/login')
                  }}
                >
                  退出
                </Button>
              </Space>
            </Space>
          </div>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
