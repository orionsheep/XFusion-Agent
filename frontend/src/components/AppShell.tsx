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
import { Button, Input, Layout, Menu, Popover, Select, Tag, Typography, message } from 'antd'
import { type ReactNode, useEffect, useRef, useState } from 'react'
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

const { Content } = Layout

type WorkspaceItem = {
  key: string
  icon: ReactNode
  label: string
  description: string
}

const workspaceItems: WorkspaceItem[] = [
  { key: '/overview', icon: <DashboardOutlined />, label: '总览', description: '全局态势与总览' },
  { key: '/hosts', icon: <DeploymentUnitOutlined />, label: '主机与服务', description: '主机纳管与服务详情' },
  { key: '/tasks', icon: <PoweroffOutlined />, label: '任务中心', description: 'Goal-driven 任务编排' },
  { key: '/approvals', icon: <SafetyCertificateOutlined />, label: '审批中心', description: '高风险操作审批' },
  { key: '/audit', icon: <AuditOutlined />, label: '审计日志', description: '执行留痕与追踪' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置', description: '模型、账号与平台配置' },
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
    sessionId,
    createNewConversation,
  } = useAgentConsole()
  const [activePopover, setActivePopover] = useState<'model' | 'hosts' | 'workspace' | 'session' | null>(null)
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
      setActivePopover(null)
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '模型切换失败')
    },
  })

  const workspaceOpen = location.pathname !== '/'
  const selectedWorkspaceKey = getSelectedWorkspaceKey(location.pathname)
  const selectedWorkspaceLabel = workspaceItems.find((item) => item.key === selectedWorkspaceKey)?.label ?? '总览'
  const activeModelAlias = runtimeProfile?.active?.gateway_custom_model_option_name
    ?? runtimeProfile?.active?.gateway_model
    ?? runtimeProfile?.active?.claude_model
  const modelLabel = activeModelAlias
    ?? '未配置模型'
  const totalHostCount = overview?.hosts?.length ?? 0
  const hostOptions = hosts.map((host: any) => ({
    label: `${host.name} (${host.address})`,
    value: host.id,
  }))
  const hostNameMap = new Map<number, string>(hosts.map((host: any) => [Number(host.id), String(host.name)]))

  useEffect(() => {
    if (activeModelAlias) {
      setSelectedModel(activeModelAlias)
    }
  }, [activeModelAlias])

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

  const modelCard = (
    <div className="control-popover-card">
      <div className="control-popover-card__header">
        <Typography.Text className="page-kicker">MODEL RUNTIME</Typography.Text>
        <Typography.Title level={5} style={{ margin: '4px 0 0' }}>模型切换</Typography.Title>
        <Typography.Text type="secondary">切换当前 Agent 运行模型，保持 Gateway 路由和会话上下文不变。</Typography.Text>
      </div>
      <div className="control-popover-card__section">
        <Typography.Text strong>当前运行模型</Typography.Text>
        <div className="control-stat-pill">
          <span>{runtimeProfile?.active?.gateway_provider ?? 'provider'}</span>
          <strong>{modelLabel}</strong>
        </div>
      </div>
      <div className="control-popover-card__section">
        <Typography.Text strong>可用模型</Typography.Text>
        <div className="model-picker-grid">
          {(runtimeProfile?.available_models ?? []).map((model: string) => {
            const active = selectedModel === model
            return (
              <button
                key={model}
                type="button"
                className={`model-picker-card${active ? ' is-active' : ''}`}
                onClick={() => setSelectedModel(model)}
              >
                <strong>{model}</strong>
                <span>{model.startsWith('GLM') ? '智谱 Gateway' : 'MiniMax Gateway'}</span>
              </button>
            )
          })}
        </div>
      </div>
      <Button
        type="primary"
        disabled={!selectedModel || selectedModel === activeModelAlias}
        loading={updateRuntimeProfileMutation.isPending}
        onClick={() => {
          if (!selectedModel) return
          const provider = selectedModel.startsWith('GLM') ? 'zhipu' : 'minimax'
          updateRuntimeProfileMutation.mutate({ modelAlias: selectedModel, provider })
        }}
      >
        应用模型
      </Button>
    </div>
  )

  const hostsCard = (
    <div className="control-popover-card control-popover-card--wide">
      <div className="control-popover-card__header">
        <Typography.Text className="page-kicker">TARGET HOSTS</Typography.Text>
        <Typography.Title level={5} style={{ margin: '4px 0 0' }}>目标主机</Typography.Title>
        <Typography.Text type="secondary">定义当前会话默认操作哪些远程服务器，Agent 会自动把这些主机加入上下文。</Typography.Text>
      </div>
      <div className="control-popover-card__section">
        <Typography.Text strong>当前目标</Typography.Text>
        <div className="host-pill-row">
          {selectedHosts.length ? selectedHosts.map((hostId) => (
            <Tag key={hostId} color="green">{hostNameMap.get(hostId) ?? `host-${hostId}`}</Tag>
          )) : <Typography.Text type="secondary">当前还没有选中主机</Typography.Text>}
        </div>
      </div>
      <div className="control-popover-card__section">
        <Typography.Text strong>编辑目标主机</Typography.Text>
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
          showSearch
        />
      </div>
      <div className="control-popover-card__actions">
        <Button onClick={() => setSelectedHosts(hosts.map((host: any) => host.id))}>选中全部</Button>
        <Button onClick={() => setSelectedHosts([])}>清空</Button>
        <Button
          type="primary"
          onClick={() => {
            setActivePopover(null)
            navigate('/hosts')
          }}
        >
          打开主机与服务
        </Button>
      </div>
    </div>
  )

  const workspaceCard = (
    <div className="control-popover-card control-popover-card--workspace">
      <div className="control-popover-card__header">
        <Typography.Text className="page-kicker">SECONDARY WORKSPACES</Typography.Text>
        <Typography.Title level={5} style={{ margin: '4px 0 0' }}>工作区</Typography.Title>
        <Typography.Text type="secondary">首页只保留 Agent，对外工作面都从这里进入。</Typography.Text>
      </div>
      <div className="workspace-launcher">
        {workspaceItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`workspace-launcher__item${selectedWorkspaceKey === item.key ? ' is-active' : ''}`}
            onClick={() => {
              navigate(item.key)
              setActivePopover(null)
            }}
          >
            <span className="workspace-launcher__icon">{item.icon}</span>
            <span className="workspace-launcher__body">
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )

  const sessionCard = (
    <div className="control-popover-card">
      <div className="control-popover-card__header">
        <Typography.Text className="page-kicker">SESSION CONTROL</Typography.Text>
        <Typography.Title level={5} style={{ margin: '4px 0 0' }}>会话设置</Typography.Title>
        <Typography.Text type="secondary">查看当前会话上下文，必要时在这里直接开启新对话。</Typography.Text>
      </div>
      <div className="control-popover-card__section">
        <Typography.Text strong>当前会话 ID</Typography.Text>
        <Input value={sessionId} readOnly />
      </div>
      <div className="control-popover-card__section">
        <Typography.Text strong>上下文范围</Typography.Text>
        <div className="control-stat-pill">
          <span>目标主机</span>
          <strong>{selectedHosts.length} 台</strong>
        </div>
      </div>
      <div className="control-popover-card__actions">
        <Button
          type="primary"
          onClick={() => {
            createNewConversation()
            messageApi.success('已创建新的 Agent 会话')
            setActivePopover(null)
          }}
        >
          开启新对话
        </Button>
      </div>
    </div>
  )

  return (
    <Layout className="app-shell kimi-shell">
      {contextHolder}
      <aside className="kimi-sidebar">
        <div className="kimi-sidebar__top">
          <div className="kimi-sidebar__brand-row">
            <button type="button" className="kimi-sidebar__brand" onClick={() => navigate('/')}>
              <span className="kimi-sidebar__brand-mark">X</span>
              <span>XFusion Agent</span>
            </button>
            <button type="button" className="kimi-sidebar__collapse" aria-label="收起侧边栏">
              ⌘
            </button>
          </div>

          <button
            type="button"
            className="kimi-sidebar__new-chat"
            onClick={() => {
              createNewConversation()
              messageApi.success('已创建新的 Agent 会话')
              navigate('/')
            }}
          >
            <PlusOutlined />
            <span>新建会话</span>
            <kbd>⌘</kbd><kbd>K</kbd>
          </button>

          <nav className="kimi-sidebar__nav" aria-label="工作区">
            {workspaceItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`kimi-sidebar__nav-item${selectedWorkspaceKey === item.key && workspaceOpen ? ' is-active' : ''}`}
                onClick={() => {
                  navigate(item.key)
                  setActivePopover(null)
                }}
              >
                <span className="kimi-sidebar__nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="kimi-sidebar__middle">
          <Popover
            trigger="click"
            placement="right"
            content={modelCard}
            overlayClassName="control-popover"
          >
            <button type="button" className="kimi-sidebar__nav-item kimi-sidebar__nav-item--control">
              <span className="kimi-sidebar__nav-icon"><SettingOutlined /></span>
              <span>{modelLabel}</span>
            </button>
          </Popover>
          <Popover
            trigger="click"
            placement="right"
            content={hostsCard}
            overlayClassName="control-popover"
          >
            <button type="button" className="kimi-sidebar__nav-item kimi-sidebar__nav-item--control">
              <span className="kimi-sidebar__nav-icon"><DeploymentUnitOutlined /></span>
              <span>{selectedHosts.length || totalHostCount} 台目标主机</span>
            </button>
          </Popover>
        </div>

        <div className="kimi-sidebar__bottom">
          <button type="button" className="kimi-sidebar__nav-item">
            <span className="kimi-sidebar__nav-icon">ⓘ</span>
            <span>关于我们</span>
          </button>
          <button type="button" className="kimi-sidebar__nav-item">
            <span className="kimi-sidebar__nav-icon">文</span>
            <span>Language</span>
          </button>
          <button type="button" className="kimi-sidebar__nav-item">
            <span className="kimi-sidebar__nav-icon">✉</span>
            <span>用户反馈</span>
          </button>
          <button
            type="button"
            className="kimi-sidebar__user"
            onClick={() => {
              clearStoredToken()
              navigate('/login')
            }}
          >
            <span className="kimi-sidebar__avatar">A</span>
            <span>退出</span>
          </button>
        </div>
      </aside>

      <Content className="app-shell__content kimi-canvas">
        <AgentPanel />

        <div className="kimi-floating-controls" aria-label="快捷控制">
            <Popover
              trigger="click"
              placement="bottomRight"
              open={activePopover === 'model'}
              onOpenChange={(open) => setActivePopover(open ? 'model' : null)}
              content={modelCard}
              overlayClassName="control-popover"
            >
              <Button size="small" className="topbar__chip topbar__chip--model">
                {modelLabel}
              </Button>
            </Popover>
            <Popover
              trigger="click"
              placement="bottomRight"
              open={activePopover === 'hosts'}
              onOpenChange={(open) => setActivePopover(open ? 'hosts' : null)}
              content={hostsCard}
              overlayClassName="control-popover"
            >
              <Button size="small" className="topbar__chip topbar__chip--hosts">
                {selectedHosts.length || totalHostCount} 台目标主机
              </Button>
            </Popover>
            <Popover
              trigger="click"
              placement="bottomRight"
              open={activePopover === 'workspace'}
              onOpenChange={(open) => setActivePopover(open ? 'workspace' : null)}
              content={workspaceCard}
              overlayClassName="control-popover"
            >
              <Button size="small" className="topbar__utility" icon={<AppstoreOutlined />}>
                工作区
              </Button>
            </Popover>
            <Popover
              trigger="click"
              placement="bottomRight"
              open={activePopover === 'session'}
              onOpenChange={(open) => setActivePopover(open ? 'session' : null)}
              content={sessionCard}
              overlayClassName="control-popover"
            >
              <Button size="small" className="topbar__utility" icon={<SettingOutlined />}>
                会话设置
              </Button>
            </Popover>
            <Button
              size="small"
              className="topbar__utility"
              icon={<PlusOutlined />}
              onClick={() => {
                createNewConversation()
                messageApi.success('已创建新的 Agent 会话')
              }}
            >
              新对话
            </Button>
            <Button
              size="small"
              className="topbar__utility"
              onClick={() => {
                clearStoredToken()
                navigate('/login')
              }}
            >
              退出
            </Button>
        </div>

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
