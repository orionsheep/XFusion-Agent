import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Card, List, Progress, Skeleton, Space, Statistic, Table, Tag, Typography } from 'antd'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExpandablePanelCard } from '../components/ExpandablePanelCard'
import { collectMonitoringSnapshots, fetchIntegrations, fetchOverview } from '../services/api'

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function metricPercent(value: unknown) {
  const parsed = toNumber(value)
  return parsed === null ? null : Math.round(parsed)
}

function renderMetric(value: unknown, color: string) {
  const percent = metricPercent(value)
  if (percent === null) {
    return <Typography.Text type="secondary">N/A</Typography.Text>
  }
  return <Progress percent={percent} strokeColor={color} size="small" />
}

function formatBytes(value: unknown) {
  const raw = toNumber(value)
  if (raw === null || raw <= 0) return 'N/A'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = raw
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  const digits = size >= 10 || index === 0 ? 0 : 1
  return `${size.toFixed(digits)}${units[index]}`
}

function formatUptime(seconds: unknown, fallback?: unknown) {
  const raw = toNumber(seconds)
  if (raw !== null) {
    const total = Math.max(Math.floor(raw), 0)
    const days = Math.floor(total / 86400)
    const hours = Math.floor((total % 86400) / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const parts = []
    if (days) parts.push(`${days}天`)
    if (hours || days) parts.push(`${hours}小时`)
    parts.push(`${minutes}分钟`)
    return parts.join(' ')
  }
  return typeof fallback === 'string' && fallback.trim() ? fallback : '未采样'
}

function normalizeMemory(metrics: any) {
  const memory = metrics?.memory ?? {}
  const totalBytes = toNumber(memory.total_bytes ?? memory.total ?? (toNumber(memory.total_kb) ?? 0) * 1024)
  const usedBytes = toNumber(memory.used_bytes ?? memory.used ?? (toNumber(memory.used_kb) ?? 0) * 1024)
  return {
    totalBytes,
    usedBytes,
    percent: metricPercent(memory.percent ?? metrics?.memory_percent),
  }
}

function normalizeSwap(metrics: any) {
  const swap = metrics?.swap ?? {}
  const totalBytes = toNumber(swap.total_bytes ?? swap.total ?? (toNumber(swap.total_kb) ?? 0) * 1024)
  const usedBytes = toNumber(swap.used_bytes ?? swap.used ?? (toNumber(swap.used_kb) ?? 0) * 1024)
  return {
    totalBytes,
    usedBytes,
    percent: metricPercent(swap.percent),
  }
}

function normalizeFilesystems(metrics: any) {
  if (!Array.isArray(metrics?.filesystems)) return []
  return metrics.filesystems
    .map((item: any) => {
      const mount = item.mount ?? item.path ?? item.mounted_on ?? '/'
      const sizeBytes = toNumber(item.size_bytes ?? (toNumber(item.size_kb) ?? 0) * 1024)
      const usedBytes = toNumber(item.used_bytes ?? (toNumber(item.used_kb) ?? 0) * 1024)
      const availableBytes = toNumber(item.available_bytes ?? (toNumber(item.available_kb) ?? 0) * 1024)
      return {
        filesystem: item.filesystem ?? item.device ?? mount,
        mount,
        sizeBytes,
        usedBytes,
        availableBytes,
        percent: metricPercent(item.percent),
      }
    })
    .filter((item: any) => item.mount)
}

function loadTriplet(metrics: any) {
  if (Array.isArray(metrics?.load_average)) {
    return metrics.load_average
      .map((value: unknown) => toNumber(value))
      .filter((value: number | null): value is number => value !== null)
      .slice(0, 3)
  }
  if (typeof metrics?.load === 'string') {
    return metrics.load
      .split(',')
      .map((part: string) => toNumber(part.trim()))
      .filter((value: number | null): value is number => value !== null)
      .slice(0, 3)
  }
  return []
}

function metricTone(percent: number | null, warn = 70, danger = 85) {
  if (percent === null) return 'muted'
  if (percent >= danger) return 'danger'
  if (percent >= warn) return 'warn'
  return 'healthy'
}

function FleetMetricRow({
  label,
  percent,
  detail,
  warn = 70,
  danger = 85,
}: {
  label: string
  percent: number | null
  detail: string
  warn?: number
  danger?: number
}) {
  const tone = metricTone(percent, warn, danger)
  return (
    <div className={`fleet-meter fleet-meter--${tone}`}>
      <div className="fleet-meter__head">
        <Typography.Text>{label}</Typography.Text>
        <Typography.Text strong>{percent === null ? 'N/A' : `${percent}%`}</Typography.Text>
      </div>
      <Progress
        percent={percent ?? 0}
        size="small"
        showInfo={false}
        strokeColor={
          tone === 'danger' ? '#dc2626' : tone === 'warn' ? '#ca8a04' : tone === 'healthy' ? '#0f766e' : '#94a3b8'
        }
      />
      <Typography.Text type="secondary">{detail}</Typography.Text>
    </div>
  )
}

function FleetMonitorCard({ host, onOpen }: { host: any; onOpen: (hostId: number) => void }) {
  const system = host.system
  return (
    <div className="fleet-monitor-card">
      <div className="fleet-monitor-card__header">
        <div>
          <div className="fleet-monitor-card__title">{host.name}</div>
          <div className="fleet-monitor-card__subtitle">
            {host.address} · {host.os_type ?? 'unknown'} {host.os_version ?? ''}
          </div>
        </div>
        <Space wrap size={6}>
          <Tag color={host.status === 'online' || host.status === 'registered' ? 'green' : 'red'}>{host.status}</Tag>
          {host.alerts.length ? <Tag color="orange">{host.alerts[0]}</Tag> : <Tag color="default">稳定</Tag>}
          <Button size="small" type="link" onClick={() => onOpen(host.id)}>
            查看详情
          </Button>
        </Space>
      </div>

      <div className="fleet-monitor-card__stats">
        <div className="fleet-inline-stat">
          <span>运行时长</span>
          <strong>{system.uptimeText}</strong>
        </div>
        <div className="fleet-inline-stat">
          <span>负载</span>
          <strong>{system.loadText}</strong>
        </div>
        <div className="fleet-inline-stat">
          <span>最近采样</span>
          <strong>{system.sampledAtText}</strong>
        </div>
      </div>

      <div className="fleet-monitor-card__meters">
        <FleetMetricRow
          label="CPU"
          percent={system.cpuPercent}
          detail={host.profile_json?.systemd === 'true' ? 'systemd / SSH' : 'SSH 采样'}
        />
        <FleetMetricRow
          label="内存"
          percent={system.memory.percent}
          detail={`${formatBytes(system.memory.usedBytes)} / ${formatBytes(system.memory.totalBytes)}`}
        />
        <FleetMetricRow
          label="交换分区"
          percent={system.swap.percent}
          detail={`${formatBytes(system.swap.usedBytes)} / ${formatBytes(system.swap.totalBytes)}`}
          warn={60}
          danger={80}
        />
        <FleetMetricRow
          label="根分区"
          percent={system.rootDisk.percent}
          detail={`${formatBytes(system.rootDisk.usedBytes)} / ${formatBytes(system.rootDisk.sizeBytes)}`}
          warn={75}
          danger={85}
        />
      </div>

      <div className="fleet-monitor-card__tables">
        <div className="fleet-data-table">
          <div className="fleet-data-table__header">
            <span>高占用进程</span>
            <span>CPU / MEM</span>
          </div>
          {(system.topProcesses.length ? system.topProcesses : [{ command: '暂无数据', cpu_percent: '-', mem_percent: '-', pid: '-' }])
            .slice(0, 4)
            .map((item: any, index: number) => (
              <div className="fleet-data-table__row" key={`${host.id}-proc-${item.pid ?? index}`}>
                <div>
                  <strong>{item.command}</strong>
                  <span>PID {item.pid ?? '-'}</span>
                </div>
                <div className="fleet-data-table__metric">
                  <strong>{item.cpu_percent ?? '-'}</strong>
                  <span>{item.mem_percent ?? '-'}%</span>
                </div>
              </div>
            ))}
        </div>

        <div className="fleet-data-table">
          <div className="fleet-data-table__header">
            <span>文件系统</span>
            <span>占用</span>
          </div>
          {(system.filesystems.length ? system.filesystems : [{ mount: '/', percent: host.values.root_disk_percent, availableBytes: null, sizeBytes: null }])
            .slice(0, 5)
            .map((item: any, index: number) => (
              <div className="fleet-data-table__row" key={`${host.id}-fs-${item.mount ?? index}`}>
                <div>
                  <strong>{item.mount}</strong>
                  <span>{formatBytes(item.availableBytes)} 可用 / {formatBytes(item.sizeBytes)} 总量</span>
                </div>
                <div className="fleet-data-table__metric">
                  <strong>{item.percent === null ? 'N/A' : `${item.percent}%`}</strong>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

export function DashboardPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['overview'],
    queryFn: fetchOverview,
  })
  const { data: integrations } = useQuery({
    queryKey: ['integrations'],
    queryFn: fetchIntegrations,
  })
  const collectMutation = useMutation({
    mutationFn: collectMonitoringSnapshots,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['overview'] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })

  const hosts = data?.hosts ?? []
  const approvals = data?.approvals ?? []
  const tasks = data?.tasks ?? []

  const hostRiskView = useMemo(() => {
    return [...hosts]
      .map((host: any) => {
        const values = host.monitoring_summary?.values ?? {}
        const metrics = host.metrics_json ?? {}
        const memory = normalizeMemory(metrics)
        const swap = normalizeSwap(metrics)
        const filesystems = normalizeFilesystems(metrics)
        const rootFs =
          filesystems.find((item: any) => item.mount === '/') ??
          filesystems.find((item: any) => item.mount === '/data') ??
          filesystems[0] ??
          null
        const cpuPercent = metricPercent(values.cpu_percent ?? metrics.cpu_percent)
        const memoryPercent = metricPercent(values.memory_percent ?? memory.percent)
        const diskPercent = metricPercent(values.root_disk_percent ?? rootFs?.percent ?? metrics.disk?.percent)
        const loadValues = loadTriplet(metrics)
        const topProcesses = (host.monitoring_summary?.top_processes ?? metrics.top_processes ?? []).slice(0, 6)
        const alerts: string[] = []
        let score = 0

        if (host.status !== 'online' && host.status !== 'registered') {
          alerts.push('主机离线')
          score += 4
        }
        if (host.monitoring_summary?.available === false) {
          alerts.push('缺少采样')
          score += 1
        }
        if ((cpuPercent ?? 0) >= 85) {
          alerts.push(`CPU ${cpuPercent}%`)
          score += 3
        }
        if ((memoryPercent ?? 0) >= 85) {
          alerts.push(`内存 ${memoryPercent}%`)
          score += 3
        }
        if ((diskPercent ?? 0) >= 80) {
          alerts.push(`磁盘 ${diskPercent}%`)
          score += 2
        }

        return {
          ...host,
          values: {
            ...values,
            cpu_percent: cpuPercent,
            memory_percent: memoryPercent,
            root_disk_percent: diskPercent,
          },
          alerts,
          score,
          system: {
            cpuPercent,
            memory,
            swap,
            filesystems,
            rootDisk: {
              percent: diskPercent,
              sizeBytes: rootFs?.sizeBytes ?? null,
              usedBytes: rootFs?.usedBytes ?? null,
            },
            loadText: loadValues.length
              ? loadValues.map((value: number) => value.toFixed(2)).join(', ')
              : host.monitoring_summary?.values?.load1 ?? 'N/A',
            uptimeText: formatUptime(metrics.uptime_seconds, metrics.uptime_human),
            sampledAtText:
              host.monitoring_summary?.sampled_at
                ? new Date(host.monitoring_summary.sampled_at).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })
                : '未采样',
            topProcesses,
          },
        }
      })
      .sort((left, right) => right.score - left.score || (right.values.cpu_percent ?? 0) - (left.values.cpu_percent ?? 0))
  }, [hosts])

  const riskHosts = hostRiskView.filter((host: any) => host.score > 0)
  const pendingApprovals = approvals.filter((approval: any) => approval.status === 'pending')
  const runningTasks = tasks.filter((task: any) => task.status === 'running')
  const failedTasks = tasks.filter((task: any) => task.status === 'failed')
  const onlineRate = hosts.length ? Math.round(((data?.stats?.online_hosts ?? 0) / hosts.length) * 100) : 0
  const avgCpu = hostRiskView.length
    ? Math.round(hostRiskView.reduce((sum: number, host: any) => sum + (host.values.cpu_percent ?? 0), 0) / hostRiskView.length)
    : 0
  const hottestHost = hostRiskView[0]

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 14 }} />
  }

  const fleetColumns = [
    {
      title: '主机',
      key: 'host',
      render: (_: unknown, host: any) => (
        <div>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {host.name}
          </Typography.Title>
          <Typography.Text type="secondary">
            {host.address} · {host.os_type ?? 'unknown'} {host.os_version ?? ''}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_: unknown, host: any) => (
        <Space wrap>
          <Tag color={host.status === 'online' || host.status === 'registered' ? 'green' : 'red'}>
            {host.status}
          </Tag>
          {host.alerts.length ? <Tag color="orange">{host.alerts[0]}</Tag> : <Tag>稳定</Tag>}
        </Space>
      ),
    },
    {
      title: 'CPU',
      key: 'cpu',
      width: 180,
      render: (_: unknown, host: any) => renderMetric(host.values.cpu_percent, '#0f766e'),
    },
    {
      title: '内存',
      key: 'memory',
      width: 180,
      render: (_: unknown, host: any) => renderMetric(host.values.memory_percent, '#0891b2'),
    },
    {
      title: '磁盘',
      key: 'disk',
      width: 180,
      render: (_: unknown, host: any) => renderMetric(host.values.root_disk_percent, '#ca8a04'),
    },
    {
      title: 'Load',
      key: 'load',
      width: 120,
      render: (_: unknown, host: any) => <Typography.Text>{host.system.loadText}</Typography.Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: unknown, host: any) => (
        <Button type="link" onClick={() => navigate(`/hosts/${host.id}`)}>
          查看详情
        </Button>
      ),
    },
  ]

  return (
    <div className="page-shell">
      <div className="page-shell__body">
        <Card className="dashboard-strip panel-card resizable-card">
          <div className="dashboard-strip__inner">
            <Space wrap size={10}>
              <Typography.Text strong>全局主机态势</Typography.Text>
              <Typography.Text type="secondary">主机态势工作台支持扩展成系统监控工作台</Typography.Text>
            </Space>
            <Space wrap size={8}>
              <Tag color="green">已纳管 {data?.stats?.hosts ?? 0} 台</Tag>
              <Tag color={pendingApprovals.length ? 'gold' : 'default'}>待审批 {pendingApprovals.length}</Tag>
              <Button size="small" loading={collectMutation.isPending} onClick={() => collectMutation.mutate()}>
                刷新全部快照
              </Button>
            </Space>
          </div>
        </Card>

        <ExpandablePanelCard className="panel-card resizable-card" title="主机态势工作台" fullscreenLabel="主机态势工作台">
          {({ anyFullscreen }) => (
            <div className="panel-card__content">
              {anyFullscreen ? (
                <div className="fleet-monitor-fullscreen">
                  <div className="fleet-monitor-hero">
                    <div className="fleet-monitor-hero__intro">
                      <div className="page-kicker">Fleet monitor</div>
                      <h2 className="page-title">主机态势工作台</h2>
                      <p className="page-subtitle">以每台主机为单位展开系统状态、进程压力和文件系统容量，快速定位高风险节点。</p>
                    </div>
                    <div className="fleet-monitor-hero__stats">
                      <div className="fleet-monitor-chip">
                        <span>在线率</span>
                        <strong>{onlineRate}%</strong>
                      </div>
                      <div className="fleet-monitor-chip">
                        <span>风险主机</span>
                        <strong>{riskHosts.length}</strong>
                      </div>
                      <div className="fleet-monitor-chip">
                        <span>平均 CPU</span>
                        <strong>{avgCpu}%</strong>
                      </div>
                      <div className="fleet-monitor-chip">
                        <span>热节点</span>
                        <strong>{hottestHost?.name ?? 'N/A'}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="fleet-monitor-grid">
                    {hostRiskView.map((host: any) => (
                      <FleetMonitorCard key={host.id} host={host} onOpen={(hostId) => navigate(`/hosts/${hostId}`)} />
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <Card
                    type="inner"
                    className="panel-subcard resizable-subcard fleet-overview-card"
                    title="服务器总览"
                    extra={<Tag>{hostRiskView.length} 台主机</Tag>}
                  >
                    <div className="panel-subcard__content">
                      <Table
                        rowKey="id"
                        dataSource={hostRiskView}
                        columns={fleetColumns}
                        size="small"
                        pagination={false}
                        scroll={{ x: 980 }}
                      />
                    </div>
                  </Card>

                  <Card type="inner" className="panel-subcard resizable-subcard summary-ribbon-card" title="关键指标">
                    <div className="summary-ribbon">
                      <div className="summary-ribbon__item">
                        <Typography.Text type="secondary">在线率</Typography.Text>
                        <Statistic title={null} value={onlineRate} suffix="%" />
                      </div>
                      <div className="summary-ribbon__item">
                        <Typography.Text type="secondary">风险主机</Typography.Text>
                        <Statistic title={null} value={riskHosts.length} />
                      </div>
                      <div className="summary-ribbon__item">
                        <Typography.Text type="secondary">待审批</Typography.Text>
                        <Statistic title={null} value={pendingApprovals.length} />
                      </div>
                      <div className="summary-ribbon__item">
                        <Typography.Text type="secondary">运行中任务</Typography.Text>
                        <Statistic title={null} value={runningTasks.length} />
                      </div>
                      <div className="summary-ribbon__item">
                        <Typography.Text type="secondary">平均 CPU</Typography.Text>
                        <Statistic title={null} value={avgCpu} suffix="%" />
                      </div>
                    </div>
                  </Card>
                </>
              )}
            </div>
          )}
        </ExpandablePanelCard>

        {riskHosts.length || pendingApprovals.length || failedTasks.length ? (
          <Alert
            type={riskHosts.length || failedTasks.length ? 'warning' : 'info'}
            message={`当前需要优先处理 ${riskHosts.length} 台风险主机、${pendingApprovals.length} 条审批、${failedTasks.length} 条失败任务。`}
            showIcon
          />
        ) : null}

        <ExpandablePanelCard className="panel-card resizable-card" title="风险与执行观察" fullscreenLabel="风险与执行观察">
          <div className="panel-card__content">
            <div className="panel-subgrid panel-subgrid--2">
              <Card
                type="inner"
                className="panel-subcard resizable-subcard"
                title="待处理事项"
                extra={<Tag color={pendingApprovals.length || failedTasks.length ? 'gold' : 'default'}>{pendingApprovals.length + failedTasks.length} 项</Tag>}
              >
                <div className="panel-subcard__content">
                  <List
                    dataSource={[
                      ...pendingApprovals.map((approval: any) => ({
                        key: `approval-${approval.id}`,
                        title: `审批 #${approval.id}`,
                        description: `任务 ${approval.task_id} 等待处理`,
                        tag: { color: 'gold', text: '待审批' },
                        action: () => navigate('/approvals'),
                      })),
                      ...failedTasks.map((task: any) => ({
                        key: `task-${task.id}`,
                        title: task.title,
                        description: task.prompt,
                        tag: { color: 'red', text: '失败任务' },
                        action: () => navigate('/tasks'),
                      })),
                    ]}
                    locale={{ emptyText: '当前没有待处理事项' }}
                    renderItem={(item: any) => (
                      <List.Item
                        actions={[
                          <Button type="link" key="open" onClick={item.action}>
                            打开
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta title={item.title} description={item.description} />
                        <Tag color={item.tag.color}>{item.tag.text}</Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>

              <Card
                type="inner"
                className="panel-subcard resizable-subcard"
                title="风险主机"
                extra={<Tag color={riskHosts.length ? 'red' : 'default'}>{riskHosts.length} 台</Tag>}
              >
                <div className="panel-subcard__content">
                  <List
                    dataSource={riskHosts.slice(0, 5)}
                    locale={{ emptyText: '当前没有高风险主机' }}
                    renderItem={(host: any) => (
                      <List.Item
                        actions={[
                          <Button type="link" key="detail" onClick={() => navigate(`/hosts/${host.id}`)}>
                            查看详情
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta
                          title={host.name}
                          description={`${host.address} · ${host.alerts.join(' / ') || '暂无异常'}`}
                        />
                        <Tag color={host.status === 'online' || host.status === 'registered' ? 'green' : 'red'}>
                          {host.status}
                        </Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard" title="最近任务">
                <div className="panel-subcard__content">
                  <List
                    dataSource={tasks.slice(0, 6)}
                    renderItem={(task: any) => (
                      <List.Item
                        actions={[
                          <Button type="link" key="open" onClick={() => navigate('/tasks')}>
                            查看
                          </Button>,
                        ]}
                      >
                        <List.Item.Meta title={task.title} description={task.prompt} />
                        <Tag color={task.status === 'succeeded' ? 'green' : task.status === 'waiting_approval' ? 'gold' : task.status === 'failed' ? 'red' : 'blue'}>
                          {task.status}
                        </Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard" title="内建能力模块">
                <div className="panel-subcard__content">
                  <List
                    dataSource={integrations?.providers ?? []}
                    renderItem={(provider: any) => (
                      <List.Item>
                        <List.Item.Meta title={provider.name} description={provider.description} />
                        <Tag color={provider.status?.reachable ? 'green' : 'default'}>
                          {provider.status?.reachable ? 'active' : 'inactive'}
                        </Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>
            </div>
          </div>
        </ExpandablePanelCard>
      </div>
    </div>
  )
}
