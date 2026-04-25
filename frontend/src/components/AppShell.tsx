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
import { Button, Input, Layout, Menu, Popover, Typography, message } from 'antd'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AgentPanel } from './AgentPanel'
import { AgentConsoleProvider, useAgentConsole } from './AgentConsoleContext'
import {
  clearStoredToken,
  fetchHosts,
  fetchOverview,
  fetchRuntimeLlmProfile,
  fetchTasks,
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

function getGatewayProvider(modelAlias: string) {
  if (modelAlias.startsWith('GLM')) return 'zhipu'
  if (modelAlias.startsWith('MiniMax')) return 'minimax'
  return undefined
}

function metricPercent(value: unknown) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function formatHostOs(host: any) {
  const os = [host.os_type, host.os_version].filter(Boolean).join(' ')
  return os || host.environment || 'unknown'
}

function getHostMetrics(host: any) {
  const values = host.monitoring_summary?.values ?? {}
  const metrics = host.metrics_json ?? {}
  return {
    cpu: metricPercent(values.cpu_percent ?? metrics.cpu_percent),
    memory: metricPercent(values.memory_percent ?? metrics.memory?.percent),
    disk: metricPercent(values.root_disk_percent ?? metrics.disk?.percent),
    load: values.load1 ?? metrics.load_average?.[0] ?? 'N/A',
  }
}

function getEffectiveHostStatus(host: any) {
  const rawMetrics = host.metrics_json?.raw
  const rawSuccess = rawMetrics?.success
  const stderr = String(rawMetrics?.stderr ?? '').toLowerCase()
  if (rawSuccess === false || stderr.includes('connection lost') || stderr.includes('timed out')) {
    return {
      status: 'offline',
      label: 'offline',
      isOnline: false,
      reason: rawMetrics?.stderr || '最近一次采集失败',
    }
  }
  const rawStatus = String(host.status || 'unknown').toLowerCase()
  const isOnline = ['online', 'registered'].includes(rawStatus)
  return {
    status: rawStatus,
    label: rawStatus || 'unknown',
    isOnline,
    reason: isOnline ? '最近一次采集成功' : '主机未在线',
  }
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
    setSessionId,
    setPrompt,
    createNewConversation,
  } = useAgentConsole()
  const [activePopover, setActivePopover] = useState<'model' | 'hosts' | 'workspace' | 'session' | null>(null)
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
  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
    refetchInterval: 5000,
  })

  const updateRuntimeProfileMutation = useMutation({
    mutationFn: ({ modelAlias, provider }: { modelAlias: string; provider?: string }) =>
      updateRuntimeLlmProfile(modelAlias, provider),
    onMutate: async ({ modelAlias, provider }) => {
      await queryClient.cancelQueries({ queryKey: ['runtime-llm-profile'] })
      const previousProfile = queryClient.getQueryData(['runtime-llm-profile'])
      const nextProvider = provider ?? getGatewayProvider(modelAlias)
      queryClient.setQueryData(['runtime-llm-profile'], (oldProfile: any) => ({
        ...oldProfile,
        active: {
          ...(oldProfile?.active ?? {}),
          claude_model: modelAlias,
          gateway_custom_model_option: modelAlias,
          gateway_custom_model_option_name: modelAlias,
          gateway_custom_model_option_description: `${modelAlias} routed through LiteLLM`,
          gateway_provider: nextProvider ?? oldProfile?.active?.gateway_provider,
          gateway_model: modelAlias,
        },
        available_models: oldProfile?.available_models?.includes(modelAlias)
          ? oldProfile.available_models
          : [...(oldProfile?.available_models ?? []), modelAlias],
      }))
      return { previousProfile }
    },
    onSuccess: (profile) => {
      queryClient.setQueryData(['runtime-llm-profile'], profile)
      messageApi.success('模型切换已生效')
      queryClient.invalidateQueries({ queryKey: ['runtime-llm-profile'] })
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
      setActivePopover(null)
    },
    onError: (error: any, _variables, context) => {
      if (context?.previousProfile) {
        queryClient.setQueryData(['runtime-llm-profile'], context.previousProfile)
      }
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
  const onlineHostIds = hosts
    .filter((host: any) => getEffectiveHostStatus(host).isOnline)
    .map((host: any) => host.id)

  useEffect(() => {
    const interactiveSelector = 'button, input, textarea, select, option, a, .ant-select, .ant-btn, .ant-tag, .ant-menu, [role="button"]'
    const handleSelector = '.window-drag-handle, .ant-card-head, .workspace-overlay__dragbar, .workspace-overlay__content-header, .workspace-overlay__rail-header, .agent-stage__hero'
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

  const conversationHistory = useMemo(() => {
    const grouped = new Map<string, {
      sessionId: string
      title: string
      prompt: string
      updatedAt: string
      count: number
      status: string
    }>()
    tasks.forEach((task: any) => {
      const taskSessionId = String(task.session_id || 'default')
      const updatedAt = String(task.updated_at || task.created_at || '')
      const existing = grouped.get(taskSessionId)
      if (!existing || updatedAt > existing.updatedAt) {
        grouped.set(taskSessionId, {
          sessionId: taskSessionId,
          title: String(task.title || '未命名会话'),
          prompt: String(task.prompt || ''),
          updatedAt,
          count: (existing?.count ?? 0) + 1,
          status: String(task.status || ''),
        })
      } else {
        existing.count += 1
      }
    })
    return Array.from(grouped.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 28)
  }, [tasks])

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
            const active = activeModelAlias === model
            const switching = updateRuntimeProfileMutation.isPending
              && updateRuntimeProfileMutation.variables?.modelAlias === model
            return (
              <button
                key={model}
                type="button"
                className={`model-picker-card${active ? ' is-active' : ''}${switching ? ' is-switching' : ''}`}
                disabled={active || updateRuntimeProfileMutation.isPending}
                onClick={() => {
                  const provider = getGatewayProvider(model)
                  updateRuntimeProfileMutation.mutate({ modelAlias: model, provider })
                }}
              >
                <strong>{model}</strong>
                <span>
                  {switching
                    ? '切换中...'
                    : active
                      ? '当前运行'
                      : model.startsWith('GLM') ? '智谱 Gateway' : 'MiniMax Gateway'}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <Typography.Text type="secondary" className="control-popover-card__hint">
        点击模型卡片后立即切换，顶部按钮、Agent 输入区和新任务会同步使用新模型。
      </Typography.Text>
    </div>
  )

  const hostsCard = (
    <div className="control-popover-card control-popover-card--hosts">
      <div className="control-popover-card__header">
        <Typography.Text className="page-kicker">TARGET HOSTS</Typography.Text>
        <Typography.Title level={5} style={{ margin: '4px 0 0' }}>目标主机</Typography.Title>
        <Typography.Text type="secondary">定义当前会话默认操作哪些远程服务器，Agent 会自动把这些主机加入上下文。</Typography.Text>
      </div>
      <div className="host-target-summary">
        <div>
          <strong>{selectedHosts.length}</strong>
          <span>已选主机</span>
        </div>
        <div>
          <strong>{onlineHostIds.length}</strong>
          <span>在线主机</span>
        </div>
        <div>
          <strong>{hosts.length}</strong>
          <span>纳管总数</span>
        </div>
      </div>
      <div className="control-popover-card__section">
        <div className="host-target-section-title">
          <Typography.Text strong>选择本轮 Agent 目标</Typography.Text>
          <Typography.Text type="secondary">点击卡片即可加入或移除。</Typography.Text>
        </div>
        <div className="host-target-grid">
          {hosts.map((host: any) => {
            const selected = selectedHosts.includes(host.id)
            const metrics = getHostMetrics(host)
            const reachability = getEffectiveHostStatus(host)
            const toggleHost = () => {
              setRoutePinnedHostId(null)
              setSelectedHosts(
                selected
                  ? selectedHosts.filter((hostId) => hostId !== host.id)
                  : [...selectedHosts, host.id],
              )
            }
            return (
              <button
                key={host.id}
                type="button"
                className={`host-target-card${selected ? ' is-selected' : ''}`}
                onClick={toggleHost}
              >
                <span className="host-target-card__topline">
                  <strong>{host.name}</strong>
                  <span className={`host-target-card__status is-${reachability.status}`}>{reachability.label}</span>
                </span>
                <span className="host-target-card__meta">
                  {host.address} · {formatHostOs(host)}
                </span>
                <span className="host-target-card__metrics">
                  <span>
                    CPU
                    <i><b style={{ width: `${metrics.cpu ?? 0}%` }} /></i>
                    <em>{metrics.cpu === null ? 'N/A' : `${metrics.cpu}%`}</em>
                  </span>
                  <span>
                    MEM
                    <i><b style={{ width: `${metrics.memory ?? 0}%` }} /></i>
                    <em>{metrics.memory === null ? 'N/A' : `${metrics.memory}%`}</em>
                  </span>
                  <span>
                    DISK
                    <i><b style={{ width: `${metrics.disk ?? 0}%` }} /></i>
                    <em>{metrics.disk === null ? 'N/A' : `${metrics.disk}%`}</em>
                  </span>
                </span>
                <span className="host-target-card__footer">
                  <span title={reachability.reason}>Load {String(metrics.load)}</span>
                  <span>{selected ? '已加入上下文' : '点击加入'}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="control-popover-card__actions">
        <Button onClick={() => {
          setRoutePinnedHostId(null)
          setSelectedHosts(onlineHostIds.length ? onlineHostIds : hosts.map((host: any) => host.id))
        }}>选择在线</Button>
        <Button onClick={() => {
          setRoutePinnedHostId(null)
          setSelectedHosts(hosts.map((host: any) => host.id))
        }}>全选</Button>
        <Button onClick={() => {
          setRoutePinnedHostId(null)
          setSelectedHosts([])
        }}>清空</Button>
        <Button
          icon={<PlusOutlined />}
          onClick={() => {
            setActivePopover(null)
            navigate('/hosts?new=1')
          }}
        >
          新增主机
        </Button>
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

          <section className="kimi-sidebar__history" aria-label="聊天记录">
            <div className="kimi-sidebar__history-title">聊天记录</div>
            {conversationHistory.length ? (
              <div className="kimi-sidebar__history-list">
                {conversationHistory.map((item) => (
                  <button
                    key={item.sessionId}
                    type="button"
                    className={`kimi-sidebar__history-item${item.sessionId === sessionId ? ' is-active' : ''}`}
                    onClick={() => {
                      setSessionId(item.sessionId)
                      setPrompt('')
                      navigate('/')
                    }}
                  >
                    <span className="kimi-sidebar__history-name">{item.title}</span>
                    <span className="kimi-sidebar__history-prompt">{item.prompt || item.sessionId}</span>
                    <span className="kimi-sidebar__history-meta">{item.count} 条 · {item.status || 'unknown'}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="kimi-sidebar__history-empty">暂无会话，发起一个任务后会在这里沉淀记录。</div>
            )}
          </section>
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
              <div className="workspace-overlay__dragbar window-drag-handle">
                <span />
                <span />
                <span />
              </div>
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
