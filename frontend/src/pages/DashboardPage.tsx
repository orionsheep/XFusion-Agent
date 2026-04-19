import { useQuery } from '@tanstack/react-query'
import { Card, Col, List, Progress, Row, Skeleton, Statistic, Tag, Typography } from 'antd'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fetchIntegrations, fetchOverview } from '../services/api'

export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['overview'],
    queryFn: fetchOverview,
  })
  const { data: integrations } = useQuery({
    queryKey: ['integrations'],
    queryFn: fetchIntegrations,
  })

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 12 }} />
  }

  const stats = data?.stats ?? {}
  const hostStatusChart =
    data?.hosts?.map((host: any) => ({ name: host.name, health: host.status === 'online' || host.status === 'registered' ? 100 : 35 })) ?? []

  return (
    <div className="content-stack">
      <div>
        <h1 className="page-title">Fleet Dashboard</h1>
        <p className="page-subtitle">
          统一查看主机、服务、审批与任务的整体状态。
        </p>
      </div>

      <div className="card-grid">
        <Card><Statistic title="主机总数" value={stats.hosts ?? 0} /></Card>
        <Card><Statistic title="在线主机" value={stats.online_hosts ?? 0} /></Card>
        <Card><Statistic title="已发现服务" value={stats.services ?? 0} /></Card>
        <Card><Statistic title="待审批任务" value={stats.pending_approvals ?? 0} /></Card>
      </div>

      <Card title="内建能力内核">
        <div className="card-grid">
          {(integrations?.providers ?? []).map((provider: any) => (
            <Card key={provider.key} size="small">
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                {provider.name}
              </Typography.Title>
              <Typography.Paragraph style={{ minHeight: 44 }}>
                {provider.description}
              </Typography.Paragraph>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <Tag color={provider.status?.reachable ? 'green' : 'default'}>
                  {provider.status?.reachable ? 'active' : 'inactive'}
                </Tag>
                <Typography.Text type="secondary">
                  {Object.entries(provider.stats ?? {})
                    .map(([key, value]) => `${key}:${value}`)
                    .join(' · ') || 'first-party'}
                </Typography.Text>
              </div>
            </Card>
          ))}
        </div>
      </Card>

      <div className="two-col">
        <Card title="主机健康概览">
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer>
              <BarChart data={hostStatusChart}>
                <XAxis dataKey="name" hide />
                <YAxis hide />
                <Tooltip />
                <Bar dataKey="health" fill="#0f766e" radius={12} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="最近审批">
          <List
            dataSource={data?.approvals ?? []}
            renderItem={(item: any) => (
              <List.Item>
                <List.Item.Meta
                  title={`审批 #${item.id}`}
                  description={`任务 ${item.task_id} · 状态 ${item.status}`}
                />
                <Tag color={item.status === 'pending' ? 'gold' : 'green'}>{item.status}</Tag>
              </List.Item>
            )}
          />
        </Card>
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={12}>
          <Card title="主机状态">
            <List
              dataSource={data?.hosts ?? []}
              renderItem={(host: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={host.name}
                    description={`${host.address} · ${host.os_type ?? 'unknown'} ${host.os_version ?? ''}`}
                  />
                  <div style={{ minWidth: 180 }}>
                    <Progress
                      percent={host.status === 'online' || host.status === 'registered' ? 100 : 30}
                      strokeColor="#0f766e"
                      format={() => host.status}
                    />
                  </div>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="最近任务">
            <List
              dataSource={data?.tasks ?? []}
              renderItem={(task: any) => (
                <List.Item>
                  <List.Item.Meta
                    title={task.title}
                    description={
                      <Typography.Text type="secondary">
                        {task.prompt}
                      </Typography.Text>
                    }
                  />
                  <Tag color={task.status === 'succeeded' ? 'green' : task.status === 'waiting_approval' ? 'gold' : 'blue'}>
                    {task.status}
                  </Tag>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
