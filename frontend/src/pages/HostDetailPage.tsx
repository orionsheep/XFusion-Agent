import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Col, Descriptions, List, Progress, Row, Segmented, Space, Tag, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useParams } from 'react-router-dom'
import {
  discoverHost,
  fetchHost,
  fetchHostMetrics,
  fetchHostMonitoringSummary,
  fetchHostMonitoringTimeseries,
  profileHost,
} from '../services/api'

export function HostDetailPage() {
  const { hostId } = useParams()
  const queryClient = useQueryClient()
  const hostIdNumber = Number(hostId)
  const [historyHours, setHistoryHours] = useState(6)

  const { data, isLoading } = useQuery({
    queryKey: ['host', hostIdNumber],
    queryFn: () => fetchHost(hostIdNumber),
    enabled: Number.isFinite(hostIdNumber),
  })

  const profileMutation = useMutation({
    mutationFn: () => profileHost(hostIdNumber),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', hostIdNumber] }),
  })
  const metricsMutation = useMutation({
    mutationFn: () => fetchHostMetrics(hostIdNumber),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', hostIdNumber] }),
  })
  const discoverMutation = useMutation({
    mutationFn: () => discoverHost(hostIdNumber),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', hostIdNumber] }),
  })
  const { data: monitoringSummary } = useQuery({
    queryKey: ['host-monitoring-summary', hostIdNumber],
    queryFn: () => fetchHostMonitoringSummary(hostIdNumber),
    enabled: Number.isFinite(hostIdNumber),
    refetchInterval: 30000,
  })
  const { data: monitoringTimeseries } = useQuery({
    queryKey: ['host-monitoring-timeseries', hostIdNumber, historyHours],
    queryFn: () => fetchHostMonitoringTimeseries(hostIdNumber, historyHours),
    enabled: Number.isFinite(hostIdNumber),
  })
  const chartData = useMemo(() => {
    const cpuSeries = monitoringTimeseries?.series?.cpu_percent ?? []
    const memorySeries = monitoringTimeseries?.series?.memory_percent ?? []
    const diskSeries = monitoringTimeseries?.series?.root_disk_percent ?? []
    const points = new Map<number, any>()
    for (const item of cpuSeries) {
      points.set(item.timestamp, {
        timestamp: item.timestamp,
        time: new Date(item.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        cpu: item.value,
      })
    }
    for (const item of memorySeries) {
      const point = points.get(item.timestamp) ?? {
        timestamp: item.timestamp,
        time: new Date(item.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }
      point.memory = item.value
      points.set(item.timestamp, point)
    }
    for (const item of diskSeries) {
      const point = points.get(item.timestamp) ?? {
        timestamp: item.timestamp,
        time: new Date(item.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }
      point.disk = item.value
      points.set(item.timestamp, point)
    }
    return Array.from(points.values()).sort((a, b) => a.timestamp - b.timestamp)
  }, [monitoringTimeseries])

  if (isLoading || !data) {
    return <Card loading />
  }

  const metrics = data.metrics_json ?? {}
  const externalLinks = data.external_links ?? []
  const monitoringValues = monitoringSummary?.values ?? {}

  return (
    <div className="content-stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 className="page-title">{data.name}</h1>
          <p className="page-subtitle">{data.address}</p>
        </div>
        <Space>
          <Button onClick={() => profileMutation.mutate()}>刷新画像</Button>
          <Button onClick={() => metricsMutation.mutate()}>刷新指标</Button>
          <Button type="primary" onClick={() => discoverMutation.mutate()}>
            重新发现服务
          </Button>
        </Space>
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={14}>
          <Card title="主机基础信息">
            <Descriptions column={2} bordered>
              <Descriptions.Item label="连接模式">{data.connection_mode}</Descriptions.Item>
              <Descriptions.Item label="状态">{data.status}</Descriptions.Item>
              <Descriptions.Item label="OS">{data.os_type ?? 'unknown'}</Descriptions.Item>
              <Descriptions.Item label="版本">{data.os_version ?? 'unknown'}</Descriptions.Item>
              <Descriptions.Item label="Kernel">{data.kernel_version ?? 'unknown'}</Descriptions.Item>
              <Descriptions.Item label="Package Manager">{data.package_manager ?? 'unknown'}</Descriptions.Item>
              <Descriptions.Item label="Agent URL" span={2}>
                {data.agent_url ?? '未配置'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="资源快照">
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <Typography.Text>CPU</Typography.Text>
                <Progress percent={Math.round(metrics.cpu_percent ?? 0)} strokeColor="#0f766e" />
              </div>
              <div>
                <Typography.Text>内存</Typography.Text>
                <Progress percent={Math.round(metrics.memory?.percent ?? 0)} strokeColor="#0891b2" />
              </div>
              <div>
                <Typography.Text>磁盘</Typography.Text>
                <Progress percent={Math.round(metrics.disk?.percent ?? 0)} strokeColor="#ca8a04" />
              </div>
              <Typography.Text type="secondary">
                Top Processes: {(metrics.top_processes ?? []).length}
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col xs={24} xl={8}>
          <Card title="Prometheus 即时摘要">
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <Typography.Text>抓取状态</Typography.Text>
                <Progress
                  percent={monitoringValues.up ? 100 : 0}
                  strokeColor={monitoringValues.up ? '#0f766e' : '#dc2626'}
                  format={() => (monitoringValues.up ? 'up' : 'down')}
                />
              </div>
              <div>
                <Typography.Text>CPU 使用率</Typography.Text>
                <Progress percent={Math.round(monitoringValues.cpu_percent ?? 0)} strokeColor="#0f766e" />
              </div>
              <div>
                <Typography.Text>内存使用率</Typography.Text>
                <Progress percent={Math.round(monitoringValues.memory_percent ?? 0)} strokeColor="#0891b2" />
              </div>
              <div>
                <Typography.Text>根分区使用率</Typography.Text>
                <Progress percent={Math.round(monitoringValues.root_disk_percent ?? 0)} strokeColor="#ca8a04" />
              </div>
              <Typography.Text type="secondary">load1: {monitoringValues.load1 ?? 'N/A'}</Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={16}>
          <Card
            title="Prometheus 历史曲线"
            extra={
              <Segmented
                size="small"
                value={historyHours}
                onChange={(value) => setHistoryHours(Number(value))}
                options={[
                  { label: '1h', value: 1 },
                  { label: '6h', value: 6 },
                  { label: '24h', value: 24 },
                ]}
              />
            }
          >
            <div style={{ width: '100%', height: 300 }}>
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <XAxis dataKey="time" minTickGap={32} />
                  <YAxis />
                  <Tooltip />
                  <Line type="monotone" dataKey="cpu" stroke="#0f766e" dot={false} name="CPU %" />
                  <Line type="monotone" dataKey="memory" stroke="#0891b2" dot={false} name="Memory %" />
                  <Line type="monotone" dataKey="disk" stroke="#ca8a04" dot={false} name="Disk %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
      </Row>

      <Card title="已发现服务">
        <List
          dataSource={data.services ?? []}
          renderItem={(service: any) => (
            <List.Item>
              <List.Item.Meta
                title={service.name}
                description={`${service.runtime_type} · ${service.status} · ${service.ports?.join(', ') || 'no exposed ports'}`}
              />
            </List.Item>
          )}
        />
      </Card>

      <Card title="高占用进程">
        <List
          dataSource={metrics.top_processes ?? []}
          renderItem={(item: any) => (
            <List.Item>
              <List.Item.Meta
                title={`${item.command} (#${item.pid})`}
                description={`user=${item.user} · CPU=${item.cpu_percent}% · MEM=${item.mem_percent}%`}
              />
            </List.Item>
          )}
        />
      </Card>

      <Card title="外部监控与管理入口">
        <List
          dataSource={externalLinks}
          renderItem={(item: any) => (
            <List.Item
              actions={[
                <Button key="open" href={item.url} target="_blank">
                  打开
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text strong>{item.title}</Typography.Text>
                    <Tag>{item.category}</Tag>
                  </Space>
                }
                description={
                  <Space direction="vertical" size={2}>
                    <Typography.Text type="secondary">{item.description}</Typography.Text>
                    <Typography.Text code>{item.url}</Typography.Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </Card>
    </div>
  )
}
