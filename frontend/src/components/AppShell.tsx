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
import { useEffect, useState } from 'react'
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

const MIN_NAV_WIDTH = 220
const MAX_NAV_WIDTH = 420

export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const [navWidth, setNavWidth] = useState(() => {
    if (typeof window === 'undefined') return 260
    const stored = Number(window.localStorage.getItem('xfusion_nav_width'))
    return Number.isFinite(stored)
      ? Math.min(MAX_NAV_WIDTH, Math.max(MIN_NAV_WIDTH, stored))
      : 260
  })
  const [draggingNav, setDraggingNav] = useState(false)
  const { data: overview } = useQuery({
    queryKey: ['overview'],
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

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('xfusion_nav_width', String(navWidth))
    }
  }, [navWidth])

  useEffect(() => {
    if (!draggingNav) return

    const handleMove = (event: MouseEvent) => {
      const next = Math.min(MAX_NAV_WIDTH, Math.max(MIN_NAV_WIDTH, event.clientX))
      setNavWidth(next)
    }

    const handleUp = () => setDraggingNav(false)

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [draggingNav])

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider
        width={navWidth}
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
      <div
        className={`app-nav__resize-handle${draggingNav ? ' is-dragging' : ''}`}
        onMouseDown={() => setDraggingNav(true)}
      />
      <Layout style={{ minWidth: 0 }}>
        <Header
          className="app-header"
          style={{
            background: 'transparent',
            padding: '10px 24px 0',
            height: 'auto',
            flexShrink: 0,
          }}
        >
          <div className="app-header__bar">
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <div className="app-header__title">
                <Typography.Text strong>XFusion Agent</Typography.Text>
                <div className="app-header__meta">
                  <span>多服务器状态总览、任务编排、审批与审计</span>
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
