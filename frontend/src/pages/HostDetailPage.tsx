import {
  ArrowLeftOutlined,
  DeploymentUnitOutlined,
  FundOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Breadcrumb,
  Button,
  Card,
  Descriptions,
  Empty,
  Progress,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  discoverHost,
  fetchHost,
  fetchHostMetrics,
  fetchHostMonitoringSummary,
  fetchHostMonitoringTimeseries,
  fetchTasks,
  profileHost,
} from '../services/api'

function metricPercent(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return Math.round(parsed)
  }
  return null
}

function formatTime(value?: string | null) {
  if (!value) return '未采样'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getPressureLabel(value: number | null, thresholds: { warn: number; danger: number }) {
  if (value === null) return { color: 'default', text: '未采样' }
  if (value >= thresholds.danger) return { color: 'red', text: '高压' }
  if (value >= thresholds.warn) return { color: 'gold', text: '偏高' }
  return { color: 'green', text: '稳定' }
}

function getTaskStatusColor(status: string) {
  if (status === 'succeeded') return 'green'
  if (status === 'waiting_approval') return 'gold'
  if (status === 'failed') return 'red'
  return 'blue'
}

export function HostDetailPage() {
  const { hostId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [messageApi, contextHolder] = message.useMessage()
  const [historyHours, setHistoryHours] = useState(6)
  const hostIdNumber = Number(hostId)

  const { data, isLoading } = useQuery({
    queryKey: ['host', hostIdNumber],
    queryFn: () => fetchHost(hostIdNumber),
    enabled: Number.isFinite(hostIdNumber),
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
    refetchInterval: 30000,
  })
  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
  })

  const profileMutation = useMutation({
    mutationFn: () => profileHost(hostIdNumber),
    onSuccess: () => {
      messageApi.success('主机画像已刷新')
      queryClient.invalidateQueries({ queryKey: ['host', hostIdNumber] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '主机画像刷新失败')
    },
  })
  const metricsMutation = useMutation({
    mutationFn: () => fetchHostMetrics(hostIdNumber),
    onSuccess: () => {
      messageApi.success('主机指标已刷新')
      queryClient.invalidateQueries({ queryKey: ['host', hostIdNumber] })
      queryClient.invalidateQueries({ queryKey: ['host-monitoring-summary', hostIdNumber] })
      queryClient.invalidateQueries({ queryKey: ['host-monitoring-timeseries', hostIdNumber] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '主机指标刷新失败')
    },
  })
  const discoverMutation = useMutation({
    mutationFn: () => discoverHost(hostIdNumber),
    onSuccess: () => {
      messageApi.success('服务暴露面已重新扫描')
      queryClient.invalidateQueries({ queryKey: ['host', hostIdNumber] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error: any) => {
      messageApi.error(error?.response?.data?.detail ?? '服务扫描失败')
    },
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
    return Array.from(points.values()).sort((left, right) => left.timestamp - right.timestamp)
  }, [monitoringTimeseries])

  const relatedTasks = useMemo(() => {
    return tasks.filter((task: any) => (task.target_hosts ?? []).includes(hostIdNumber)).slice(0, 6)
  }, [hostIdNumber, tasks])

  if (!Number.isFinite(hostIdNumber)) {
    return <Card><Empty description="无效的主机 ID" /></Card>
  }

  if (isLoading) {
    return <Card loading />
  }

  if (!data) {
    return <Card><Empty description="主机不存在或暂时无法加载" /></Card>
  }

  const monitoringValues = monitoringSummary?.values ?? {}
  const cpuValue = metricPercent(monitoringValues.cpu_percent ?? data.metrics_json?.cpu_percent)
  const memoryValue = metricPercent(monitoringValues.memory_percent ?? data.metrics_json?.memory?.percent)
  const diskValue = metricPercent(monitoringValues.root_disk_percent ?? data.metrics_json?.disk?.percent)
  const topProcesses = monitoringSummary?.top_processes ?? data.metrics_json?.top_processes ?? []
  const services = data.services ?? []
  const runningServices = services.filter((service: any) => service.status === 'running').length
  const degradedServices = services.filter((service: any) => ['dead', 'failed', 'inactive'].includes(service.status)).length
  const exposedServices = services.filter((service: any) => (service.ports ?? []).length > 0).length
  const cpuPressure = getPressureLabel(cpuValue, { warn: 70, danger: 85 })
  const memoryPressure = getPressureLabel(memoryValue, { warn: 70, danger: 85 })
  const diskPressure = getPressureLabel(diskValue, { warn: 75, danger: 85 })

  let diagnosisType: 'success' | 'info' | 'warning' | 'error' = 'success'
  let diagnosisTitle = '当前主机状态稳定'
  const diagnosisLines = [
    `CPU ${cpuValue === null ? 'N/A' : `${cpuValue}%`} / 内存 ${memoryValue === null ? 'N/A' : `${memoryValue}%`} / 根分区 ${diskValue === null ? 'N/A' : `${diskValue}%`} / load ${monitoringValues.load1 ?? 'N/A'}`,
  ]

  if (data.status !== 'online' && data.status !== 'registered') {
    diagnosisType = 'error'
    diagnosisTitle = '主机当前不在线'
    diagnosisLines.push('先排查网络、SSH 连通性或节点心跳。')
  } else if ((diskValue ?? 0) >= 85 || (memoryValue ?? 0) >= 85 || (cpuValue ?? 0) >= 85) {
    diagnosisType = 'warning'
    diagnosisTitle = '主机资源压力偏高'
    diagnosisLines.push('建议先看高占用进程，再结合最近任务和服务状态判断是否需要干预。')
  } else if (degradedServices > 0) {
    diagnosisType = 'info'
    diagnosisTitle = '资源稳定，但存在异常服务'
    diagnosisLines.push(`当前发现 ${degradedServices} 个异常或未运行的服务，建议优先核对核心服务状态。`)
  } else {
    diagnosisLines.push('当前没有明显的资源或服务异常，可以继续检查历史曲线和暴露面。')
  }

  const serviceColumns = [
    {
      title: '服务',
      key: 'service',
      render: (_: unknown, service: any) => (
        <div>
          <Typography.Text strong>{service.name}</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              {service.runtime_type} · {service.service_type}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: string) => (
        <Tag color={value === 'running' ? 'green' : ['dead', 'failed', 'inactive'].includes(value) ? 'red' : 'default'}>
          {value}
        </Tag>
      ),
    },
    {
      title: '暴露端口',
      key: 'ports',
      render: (_: unknown, service: any) => (
        <Typography.Text>{service.ports?.length ? service.ports.join(', ') : '无'}</Typography.Text>
      ),
    },
    {
      title: '发现来源',
      key: 'source',
      render: (_: unknown, service: any) => (
        <Typography.Text>{(service.discovery_source ?? []).join(', ') || 'unknown'}</Typography.Text>
      ),
    },
  ]

  const processColumns = [
    {
      title: '进程',
      key: 'command',
      render: (_: unknown, item: any) => (
        <div>
          <Typography.Text strong>{item.command}</Typography.Text>
          <div>
            <Typography.Text type="secondary">PID {item.pid}</Typography.Text>
          </div>
        </div>
      ),
    },
    { title: '用户', dataIndex: 'user' },
    {
      title: 'CPU',
      key: 'cpu_percent',
      render: (_: unknown, item: any) => `${item.cpu_percent ?? 0}%`,
    },
    {
      title: '内存',
      key: 'mem_percent',
      render: (_: unknown, item: any) => `${item.mem_percent ?? 0}%`,
    },
  ]

  return (
    <div className="content-stack">
      {contextHolder}
      <Breadcrumb
        items={[
          { title: 'Dashboard' },
          { title: '主机与服务' },
          { title: data.name },
        ]}
      />

      <Card className="host-hero">
        <div className="host-hero__top">
          <div>
            <div className="page-kicker">Host detail</div>
            <h1 className="page-title">{data.name}</h1>
            <p className="page-subtitle">
              {data.address} · {data.os_type ?? 'unknown'} {data.os_version ?? ''} · 最近采样 {formatTime(monitoringSummary?.sampled_at)}
            </p>
            <Space wrap style={{ marginTop: 12 }}>
              <Tag color={data.status === 'online' || data.status === 'registered' ? 'green' : 'red'}>{data.status}</Tag>
              <Tag color="cyan">{data.connection_mode}</Tag>
              <Tag color="blue">{data.environment}</Tag>
              <Tag color={cpuPressure.color}>CPU {cpuPressure.text}</Tag>
              <Tag color={memoryPressure.color}>内存 {memoryPressure.text}</Tag>
              <Tag color={diskPressure.color}>磁盘 {diskPressure.text}</Tag>
            </Space>
          </div>
          <Space wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/hosts')}>
              返回主机列表
            </Button>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={() => navigate('/tasks', { state: { selectedHosts: [hostIdNumber] } })}
            >
              去任务中心
            </Button>
            <Button icon={<ReloadOutlined />} loading={profileMutation.isPending} onClick={() => profileMutation.mutate()}>
              刷新画像
            </Button>
            <Button icon={<FundOutlined />} loading={metricsMutation.isPending} onClick={() => metricsMutation.mutate()}>
              重新采集主机指标
            </Button>
            <Button
              type="primary"
              icon={<DeploymentUnitOutlined />}
              loading={discoverMutation.isPending}
              onClick={() => discoverMutation.mutate()}
            >
              重新扫描服务暴露面
            </Button>
          </Space>
        </div>

        <div className="metric-ribbon">
          <div className="metric-ribbon__item">
            <Typography.Text type="secondary">CPU 使用率</Typography.Text>
            <Statistic title={null} value={cpuValue ?? 'N/A'} suffix={cpuValue === null ? '' : '%'} />
            {cpuValue === null ? <Typography.Text type="secondary">暂无采样</Typography.Text> : <Progress percent={cpuValue} strokeColor="#0f766e" showInfo={false} />}
          </div>
          <div className="metric-ribbon__item">
            <Typography.Text type="secondary">内存使用率</Typography.Text>
            <Statistic title={null} value={memoryValue ?? 'N/A'} suffix={memoryValue === null ? '' : '%'} />
            {memoryValue === null ? <Typography.Text type="secondary">暂无采样</Typography.Text> : <Progress percent={memoryValue} strokeColor="#0891b2" showInfo={false} />}
          </div>
          <div className="metric-ribbon__item">
            <Typography.Text type="secondary">根分区使用率</Typography.Text>
            <Statistic title={null} value={diskValue ?? 'N/A'} suffix={diskValue === null ? '' : '%'} />
            {diskValue === null ? <Typography.Text type="secondary">暂无采样</Typography.Text> : <Progress percent={diskValue} strokeColor="#ca8a04" showInfo={false} />}
          </div>
          <div className="metric-ribbon__item">
            <Typography.Text type="secondary">Load 1m</Typography.Text>
            <Statistic
              title={null}
              value={monitoringValues.load1 ?? 'N/A'}
              formatter={(value) => (typeof value === 'number' ? value.toFixed(2) : value)}
            />
            <Typography.Text type="secondary">在线采样 {monitoringValues.up ? '正常' : '异常'}</Typography.Text>
          </div>
        </div>
      </Card>

      <Alert
        type={diagnosisType}
        message={diagnosisTitle}
        description={
          <div>
            {diagnosisLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        }
        showIcon
      />

      <div className="detail-grid">
        <Card
          title="资源趋势"
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
          {chartData.length ? (
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15, 23, 42, 0.08)" />
                  <XAxis dataKey="time" minTickGap={24} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Area type="monotone" dataKey="cpu" stroke="#0f766e" fill="rgba(15, 118, 110, 0.16)" name="CPU %" />
                  <Area type="monotone" dataKey="memory" stroke="#0891b2" fill="rgba(8, 145, 178, 0.16)" name="内存 %" />
                  <Area type="monotone" dataKey="disk" stroke="#ca8a04" fill="rgba(202, 138, 4, 0.16)" name="磁盘 %" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty description="当前时间窗口内还没有历史样本" />
          )}
        </Card>

        <Card title="主机画像">
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="IP 地址">{data.address}</Descriptions.Item>
            <Descriptions.Item label="连接模式">{data.connection_mode}</Descriptions.Item>
            <Descriptions.Item label="操作系统">{`${data.os_type ?? 'unknown'} ${data.os_version ?? ''}`.trim()}</Descriptions.Item>
            <Descriptions.Item label="内核版本">{data.kernel_version ?? 'unknown'}</Descriptions.Item>
            <Descriptions.Item label="包管理器">{data.package_manager ?? 'unknown'}</Descriptions.Item>
            <Descriptions.Item label="Agent URL">{data.agent_url ?? '未配置'}</Descriptions.Item>
            <Descriptions.Item label="最近画像时间">{formatTime(data.last_profiled_at)}</Descriptions.Item>
            <Descriptions.Item label="最近在线时间">{formatTime(data.last_seen_at)}</Descriptions.Item>
          </Descriptions>

          <div className="inline-stats">
            <div className="inline-stats__item">
              <Typography.Text type="secondary">服务总数</Typography.Text>
              <Typography.Title level={4}>{services.length}</Typography.Title>
            </div>
            <div className="inline-stats__item">
              <Typography.Text type="secondary">运行中服务</Typography.Text>
              <Typography.Title level={4}>{runningServices}</Typography.Title>
            </div>
            <div className="inline-stats__item">
              <Typography.Text type="secondary">异常服务</Typography.Text>
              <Typography.Title level={4}>{degradedServices}</Typography.Title>
            </div>
            <div className="inline-stats__item">
              <Typography.Text type="secondary">暴露端口服务</Typography.Text>
              <Typography.Title level={4}>{exposedServices}</Typography.Title>
            </div>
          </div>
        </Card>
      </div>

      <div className="detail-grid">
        <Card title="已发现服务">
          <Table
            rowKey="id"
            columns={serviceColumns}
            dataSource={services}
            size="small"
            pagination={{ pageSize: 8 }}
            locale={{ emptyText: '还没有服务发现结果' }}
          />
        </Card>

        <Card title="高占用进程">
          <Table
            rowKey={(item) => `${item.pid}-${item.command}`}
            columns={processColumns}
            dataSource={topProcesses}
            size="small"
            pagination={false}
            locale={{ emptyText: '当前没有进程样本' }}
          />
        </Card>
      </div>

      <Card title="近期 AI 操作记录">
        <Table
          rowKey="id"
          size="small"
          dataSource={relatedTasks}
          pagination={false}
          locale={{ emptyText: '当前主机暂无近期 AI 任务记录' }}
          columns={[
            { title: '任务', dataIndex: 'title' },
            { title: '目标', dataIndex: 'goal' },
            {
              title: '状态',
              dataIndex: 'status',
              render: (value: string) => <Tag color={getTaskStatusColor(value)}>{value}</Tag>,
            },
            {
              title: '创建时间',
              dataIndex: 'created_at',
              render: (value: string) => formatTime(value),
            },
          ]}
        />
      </Card>
    </div>
  )
}
