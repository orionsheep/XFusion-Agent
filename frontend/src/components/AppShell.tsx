import {
  AuditOutlined,
  ClusterOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  PoweroffOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Avatar, Button, Layout, Menu, Space, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AgentPanel } from './AgentPanel'
import { clearStoredToken, fetchOverview } from '../services/api'

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
  const { data: overview } = useQuery({
    queryKey: ['overview-shell'],
    queryFn: fetchOverview,
    refetchInterval: 30000,
  })
  const selectedKey =
    items.find((item) => item.key === '/'
      ? location.pathname === '/'
      : location.pathname === item.key || location.pathname.startsWith(`${item.key}/`))?.key ?? '/'
  const riskHostCount = (overview?.hosts ?? []).filter((host: any) => {
    const values = host.monitoring_summary?.values ?? {}
    return (
      (host.status !== 'online' && host.status !== 'registered') ||
      (values.cpu_percent ?? 0) >= 85 ||
      (values.memory_percent ?? 0) >= 85 ||
      (values.root_disk_percent ?? 0) >= 80
    )
  }).length

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider
        width={260}
        theme="light"
        className="app-nav"
        style={{
          borderRight: '1px solid rgba(15, 23, 42, 0.08)',
          background: 'rgba(255,255,255,0.72)',
          backdropFilter: 'blur(16px)',
          overflow: 'auto',
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
          selectedKeys={[selectedKey]}
          items={items}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none', background: 'transparent' }}
        />
      </Sider>
      <Layout style={{ minWidth: 0 }}>
        <Header
          className="app-header"
          style={{
            background: 'transparent',
            padding: '16px 24px 0',
            height: 'auto',
            flexShrink: 0,
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
                <Typography.Text strong>AI 运维总控台</Typography.Text>
                <div style={{ color: '#64748b', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span>多服务器状态总览、任务编排、审批与审计。</span>
                  <span className={`global-health ${riskHostCount ? 'global-health--risk' : ''}`}>
                    <ClusterOutlined />
                    风险主机 {riskHostCount}
                  </span>
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
        <Content className="app-content" style={{ padding: '16px 24px 24px', overflow: 'hidden' }}>
          <div className="control-workbench">
            <section className="control-workbench__workspace">
              <Outlet />
            </section>
            <aside className="control-workbench__agent">
              <AgentPanel />
            </aside>
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
