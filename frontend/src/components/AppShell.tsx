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

const MIN_NAV_WIDTH = 168
const MAX_NAV_WIDTH = 280

export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const [navWidth, setNavWidth] = useState(() => {
    if (typeof window === 'undefined') return 176
    const stored = Number(window.localStorage.getItem('xfusion_nav_width'))
    return Number.isFinite(stored)
      ? Math.min(MAX_NAV_WIDTH, Math.max(MIN_NAV_WIDTH, stored))
      : 176
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
        <div className="app-nav__brand">
          <Typography.Title level={4} style={{ margin: 0 }}>
            XFusion Agent
          </Typography.Title>
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
            padding: '6px 16px 0',
            height: 'auto',
            flexShrink: 0,
          }}
        >
          <div className="app-header__bar app-header__bar--compact">
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space size={8}>
                <Typography.Text type="secondary">控制台</Typography.Text>
                <span className={`global-health ${riskHostCount ? 'global-health--risk' : ''}`}>
                  <ClusterOutlined />
                  风险主机 {riskHostCount}
                </span>
              </Space>
              <Space size={8}>
                <Avatar size="small" style={{ backgroundColor: '#0f766e' }}>A</Avatar>
                <Button
                  size="small"
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
