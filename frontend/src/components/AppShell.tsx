import {
  AppstoreOutlined,
  AuditOutlined,
  CloseOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  PoweroffOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Avatar, Button, Drawer, Layout, Menu, Select, Space, Tag, Typography, message } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AgentPanel } from './AgentPanel'
import { AgentConsoleProvider, useAgentConsole } from './AgentConsoleContext'
import {
  clearStoredToken,
  fetchHosts,
  fetchOverview,
  fetchRuntimeLlmProfile,
  updateRuntimeLlmProfile,
} from '../services/api'

const { Header, Content } = Layout

const workspaceItems = [
  { key: '/overview', icon: <DashboardOutlined />, label: '总览' },
  { key: '/hosts', icon: <DeploymentUnitOutlined />, label: '主机与服务' },
  { key: '/tasks', icon: <PoweroffOutlined />, label: '任务中心' },
  { key: '/approvals', icon: <SafetyCertificateOutlined />, label: '审批中心' },
  { key: '/audit', icon: <AuditOutlined />, label: '审计日志' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
]

function getSelectedWorkspaceKey(pathname: string) {
  return (
    workspaceItems.find((item) => pathname === item.key || pathname.startsWith(`${item.key}/`))?.key
    ?? '/overview'
  )
}

function AppShellInner() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [messageApi, contextHolder] = message.useMessage()
  const {
    selectedHosts,
    setSelectedHosts,
    setRoutePinnedHostId,
    setDrawerOpen,
    createNewConversation,
  } = useAgentConsole()
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false)
  const [hostDrawerOpen, setHostDrawerOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>()
  const windowZIndexRef = useRef(160)
  const { data: overview } = useQuery({
    queryKey: ['overview'],
    queryFn: fetchOverview,
    refetchInterval: 30000,
  })
  const { data: hosts = [] } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
  })
  const { data: runtimeProfile } = useQuery({
    queryKey: ['runtime-llm-profile'],
    queryFn: fetchRuntimeLlmProfile,
    refetchInterval: 30000,
  })
  const updateRuntimeProfileMutation = useMutation({
    mutationFn: ({ modelAlias, provider }: { modelAlias: string; provider?: string }) =>
      updateRuntimeLlmProfile(modelAlias, provider),
    onSuccess: () => {
      messageApi.success('模型切换已生效')
      queryClient.invalidateQueries({ queryKey: ['runtime-llm-profile'] })
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
      setModelDrawerOpen(false)
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '模型切换失败')
    },
  })

  const workspaceOpen = location.pathname !== '/'
  const selectedWorkspaceKey = getSelectedWorkspaceKey(location.pathname)
  const selectedWorkspaceLabel = workspaceItems.find((item) => item.key === selectedWorkspaceKey)?.label ?? '总览'
  const modelLabel = runtimeProfile?.active?.gateway_custom_model_option_name
    ?? runtimeProfile?.active?.gateway_model
    ?? runtimeProfile?.active?.claude_model
    ?? '未配置模型'
  const totalHostCount = overview?.hosts?.length ?? 0
  const hostOptions = hosts.map((host: any) => ({
    label: `${host.name} (${host.address})`,
    value: host.id,
  }))

  useEffect(() => {
    if (runtimeProfile?.active?.claude_model) {
      setSelectedModel(runtimeProfile.active.claude_model)
    }
  }, [runtimeProfile?.active?.claude_model])

  useEffect(() => {
    const interactiveSelector = 'button, input, textarea, select, option, a, .ant-select, .ant-btn, .ant-tag, .ant-menu, [role="button"]'
    const handleSelector = '.window-drag-handle, .ant-card-head, .workspace-overlay__content-header, .workspace-overlay__rail-header, .agent-stage__hero'
    let active:
      | {
          element: HTMLElement
          startX: number
          startY: number
          baseX: number
          baseY: number
        }
      | null = null

    const onMove = (event: MouseEvent) => {
      if (!active) return
      const nextX = active.baseX + event.clientX - active.startX
      const nextY = active.baseY + event.clientY - active.startY
      active.element.dataset.dragX = String(nextX)
      active.element.dataset.dragY = String(nextY)
      active.element.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`
    }

    const stopDrag = () => {
      if (!active) return
      active.element.classList.remove('is-window-dragging')
      active = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stopDrag)
    }

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      const handle = target.closest(handleSelector) as HTMLElement | null
      if (!handle) return
      const draggable = handle.closest('.window-draggable, .panel-card, .panel-subcard, .workspace-overlay__panel') as HTMLElement | null
      if (!draggable) return
      if (target.closest(interactiveSelector) && !target.closest('.window-drag-handle')) return

      active = {
        element: draggable,
        startX: event.clientX,
        startY: event.clientY,
        baseX: Number(draggable.dataset.dragX ?? 0),
        baseY: Number(draggable.dataset.dragY ?? 0),
      }
      windowZIndexRef.current += 1
      draggable.style.zIndex = String(windowZIndexRef.current)
      draggable.classList.add('is-window-dragging')
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', stopDrag)
    }

    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stopDrag)
    }
  }, [])

  return (
    <Layout className="app-shell">
      {contextHolder}
      <Header className="app-shell__header">
        <div className="topbar">
          <div className="topbar__brand">
            <button type="button" className="topbar__brand-button" onClick={() => navigate('/')}>
              XFusion Agent
            </button>
            <Typography.Text className="topbar__subline">
              agent-first operations console
            </Typography.Text>
          </div>
          <Space size={8} wrap>
            <Button
              size="small"
              className="topbar__chip topbar__chip--model"
              onClick={() => setModelDrawerOpen(true)}
            >
              {modelLabel}
            </Button>
            <Button
              size="small"
              className="topbar__chip topbar__chip--hosts"
              onClick={() => setHostDrawerOpen(true)}
            >
              {selectedHosts.length || totalHostCount} 台目标主机
            </Button>
            <Button
              size="small"
              icon={<AppstoreOutlined />}
              onClick={() => navigate(workspaceOpen ? selectedWorkspaceKey : '/overview')}
            >
              工作区
            </Button>
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => setDrawerOpen(true)}
            >
              会话设置
            </Button>
            <Button size="small" icon={<PlusOutlined />} onClick={createNewConversation}>
              新对话
            </Button>
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
        </div>
      </Header>

      <Content className="app-shell__content">
        <AgentPanel />

        {workspaceOpen ? (
          <div className="workspace-overlay">
            <button
              type="button"
              className="workspace-overlay__backdrop"
              aria-label="关闭工作区"
              onClick={() => navigate('/')}
            />
            <section className="workspace-overlay__panel window-draggable">
              <aside className="workspace-overlay__rail">
                <div className="workspace-overlay__rail-header">
                  <Typography.Text type="secondary">Secondary Workspace</Typography.Text>
                  <Typography.Title level={5} style={{ margin: '4px 0 0' }}>
                    工作区
                  </Typography.Title>
                </div>
                <Menu
                  selectedKeys={[selectedWorkspaceKey]}
                  items={workspaceItems}
                  onClick={({ key }) => navigate(key)}
                  style={{ borderInlineEnd: 'none', background: 'transparent' }}
                />
              </aside>

              <section className="workspace-overlay__content">
                <div className="workspace-overlay__content-header">
                  <div>
                    <Typography.Text className="page-kicker">SECONDARY SURFACE</Typography.Text>
                    <Typography.Title level={4} style={{ margin: '4px 0 0' }}>
                      {selectedWorkspaceLabel}
                    </Typography.Title>
                  </div>
                  <Button
                    size="small"
                    icon={<CloseOutlined />}
                    onClick={() => navigate('/')}
                  >
                    返回 Agent
                  </Button>
                </div>
                <div className="workspace-overlay__content-body">
                  <Outlet />
                </div>
              </section>
            </section>
          </div>
        ) : null}
      </Content>

      <Drawer
        title="模型切换"
        placement="right"
        open={modelDrawerOpen}
        onClose={() => setModelDrawerOpen(false)}
        width={360}
      >
        <div className="topbar-drawer">
          <Typography.Text strong>当前运行模型</Typography.Text>
          <Tag color="geekblue">{modelLabel}</Tag>
          <Select
            value={selectedModel}
            onChange={setSelectedModel}
            options={(runtimeProfile?.available_models ?? []).map((model: string) => ({
              value: model,
              label: model,
            }))}
          />
          <Button
            type="primary"
            disabled={!selectedModel || selectedModel === runtimeProfile?.active?.claude_model}
            loading={updateRuntimeProfileMutation.isPending}
            onClick={() => {
              if (!selectedModel) return
              const provider = selectedModel.startsWith('GLM') ? 'zhipu' : 'minimax'
              updateRuntimeProfileMutation.mutate({ modelAlias: selectedModel, provider })
            }}
          >
            切换模型
          </Button>
        </div>
      </Drawer>

      <Drawer
        title="目标主机"
        placement="right"
        open={hostDrawerOpen}
        onClose={() => setHostDrawerOpen(false)}
        width={420}
      >
        <div className="topbar-drawer">
          <Typography.Text strong>当前目标主机</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            value={selectedHosts}
            options={hostOptions}
            onChange={(values) => {
              setSelectedHosts(values)
              setRoutePinnedHostId(null)
            }}
            maxTagCount="responsive"
            placeholder="选择当前会话的远程服务器"
          />
          <Typography.Text type="secondary">
            这里决定 Agent 当前会话默认会操作哪些远程服务器。
          </Typography.Text>
          <Button onClick={() => {
            setHostDrawerOpen(false)
            navigate('/hosts')
          }}>
            打开主机与服务工作区
          </Button>
        </div>
      </Drawer>
    </Layout>
  )
}

export function AppShell() {
  return (
    <AgentConsoleProvider>
      <AppShellInner />
    </AgentConsoleProvider>
  )
}
