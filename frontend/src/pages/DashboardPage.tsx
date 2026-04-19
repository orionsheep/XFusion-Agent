import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Card, List, Progress, Skeleton, Space, Statistic, Table, Tag, Typography } from 'antd'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { collectMonitoringSnapshots, fetchIntegrations, fetchOverview } from '../services/api'

function metricPercent(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return Math.round(parsed)
  }
  return null
}

function renderMetric(value: unknown, color: string) {
  const percent = metricPercent(value)
  if (percent === null) {
    return <Typography.Text type="secondary">N/A</Typography.Text>
  }
  return <Progress percent={percent} strokeColor={color} size="small" />
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
        if ((values.cpu_percent ?? 0) >= 85) {
          alerts.push(`CPU ${metricPercent(values.cpu_percent) ?? values.cpu_percent}%`)
          score += 3
        }
        if ((values.memory_percent ?? 0) >= 85) {
          alerts.push(`内存 ${metricPercent(values.memory_percent) ?? values.memory_percent}%`)
          score += 3
        }
        if ((values.root_disk_percent ?? 0) >= 80) {
          alerts.push(`磁盘 ${metricPercent(values.root_disk_percent) ?? values.root_disk_percent}%`)
          score += 2
        }
        return {
          ...host,
          values,
          alerts,
          score,
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
      render: (_: unknown, host: any) => (
        renderMetric(host.values.cpu_percent, '#0f766e')
      ),
    },
    {
      title: '内存',
      key: 'memory',
      width: 180,
      render: (_: unknown, host: any) => (
        renderMetric(host.values.memory_percent, '#0891b2')
      ),
    },
    {
      title: '磁盘',
      key: 'disk',
      width: 180,
      render: (_: unknown, host: any) => (
        renderMetric(host.values.root_disk_percent, '#ca8a04')
      ),
    },
    {
      title: 'Load',
      key: 'load',
      width: 90,
      render: (_: unknown, host: any) => (
        <Typography.Text>{host.values.load1 ?? 'N/A'}</Typography.Text>
      ),
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
    <div className="content-stack">
      <Card className="dashboard-strip">
        <div className="dashboard-strip__inner">
          <Space wrap size={10}>
            <Typography.Text strong>全局主机态势</Typography.Text>
            <Typography.Text type="secondary">4 项核心指标优先展示</Typography.Text>
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

      <Card className="fleet-overview-card" title="服务器总览" extra={<Tag>{hostRiskView.length} 台主机</Tag>}>
        <Table
          rowKey="id"
          dataSource={hostRiskView}
          columns={fleetColumns}
          size="small"
          pagination={false}
          scroll={{ x: 980 }}
        />
      </Card>

      <div className="summary-grid">
        <Card><Statistic title="在线率" value={onlineRate} suffix="%" /></Card>
        <Card><Statistic title="风险主机" value={riskHosts.length} /></Card>
        <Card><Statistic title="待审批" value={pendingApprovals.length} /></Card>
        <Card><Statistic title="运行中任务" value={runningTasks.length} /></Card>
        <Card><Statistic title="平均 CPU" value={avgCpu} suffix="%" /></Card>
      </div>

      {riskHosts.length || pendingApprovals.length || failedTasks.length ? (
        <Alert
          type={riskHosts.length || failedTasks.length ? 'warning' : 'info'}
          message={`当前需要优先处理 ${riskHosts.length} 台风险主机、${pendingApprovals.length} 条审批、${failedTasks.length} 条失败任务。`}
          showIcon
        />
      ) : null}

      <div className="two-col">
        <Card title="待处理事项" extra={<Tag color={pendingApprovals.length || failedTasks.length ? 'gold' : 'default'}>{pendingApprovals.length + failedTasks.length} 项</Tag>}>
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
        </Card>

        <Card title="风险主机" extra={<Tag color={riskHosts.length ? 'red' : 'default'}>{riskHosts.length} 台</Tag>}>
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
        </Card>
      </div>

      <div className="two-col">
        <Card title="最近任务">
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
        </Card>

        <Card title="内建能力模块">
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
        </Card>
      </div>
    </div>
  )
}
