import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Col, Descriptions, List, Progress, Row, Space, Tag, Typography } from 'antd'
import { useParams } from 'react-router-dom'
import { discoverHost, fetchHost, fetchHostMetrics, profileHost } from '../services/api'

export function HostDetailPage() {
  const { hostId } = useParams()
  const queryClient = useQueryClient()
  const hostIdNumber = Number(hostId)

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

  if (isLoading || !data) {
    return <Card loading />
  }

  const metrics = data.metrics_json ?? {}
  const externalLinks = data.external_links ?? []

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
            </Space>
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
