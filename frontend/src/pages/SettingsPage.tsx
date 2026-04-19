import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Descriptions, List, Skeleton, Space, Tag, Typography, message } from 'antd'
import { API_BASE_URL, collectMonitoringSnapshots, fetchIntegrations, fetchPdfValidation } from '../services/api'

export function SettingsPage() {
  const queryClient = useQueryClient()
  const [messageApi, contextHolder] = message.useMessage()
  const { data, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: fetchIntegrations,
  })
  const { data: validation } = useQuery({
    queryKey: ['pdf-validation'],
    queryFn: fetchPdfValidation,
  })
  const syncMutation = useMutation({
    mutationFn: collectMonitoringSnapshots,
    onSuccess: () => {
      messageApi.success('已采集全量主机监控快照')
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
  })

  if (isLoading) {
    return <Skeleton active paragraph={{ rows: 12 }} />
  }

  return (
    <div className="page-shell">
      {contextHolder}
      <div className="page-shell__header">
        <h1 className="page-title">系统设置</h1>
        <p className="page-subtitle">当前运行配置，以及内建监控、策略、服务发现和任务编排模块的状态。</p>
      </div>

      <div className="page-shell__body">
        <Card className="panel-card resizable-card" title="平台配置与运行状态">
          <div className="panel-card__content">
            <div className="panel-subgrid panel-subgrid--2">
              <Card type="inner" className="panel-subcard resizable-subcard" title="运行配置">
                <div className="panel-subcard__content">
                  <Descriptions bordered column={1}>
                    <Descriptions.Item label="前端 API 地址">{API_BASE_URL}</Descriptions.Item>
                    <Descriptions.Item label="中央编排">Claude Agent SDK + Goal-driven Orchestrator</Descriptions.Item>
                    <Descriptions.Item label="执行通道">SSH / Node Agent / Hybrid</Descriptions.Item>
                    <Descriptions.Item label="风控">内建策略引擎 + 审批门禁</Descriptions.Item>
                  </Descriptions>
                </div>
              </Card>

              <Card
                type="inner"
                className="panel-subcard resizable-subcard"
                title="内建动作"
                extra={
                  <Space>
                    <Button loading={syncMutation.isPending} onClick={() => syncMutation.mutate()}>
                      采集全部主机快照
                    </Button>
                  </Space>
                }
              >
                <div className="panel-subcard__content">
                  <List
                    dataSource={data?.actions ?? []}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta
                          title={item.title}
                          description={item.description}
                        />
                      </List.Item>
                    )}
                  />
                </div>
              </Card>
            </div>

            <div className="panel-subgrid panel-subgrid--2">
              <Card type="inner" className="panel-subcard resizable-subcard" title="内建模块状态">
                <div className="panel-subcard__content">
                  <List
                    dataSource={data?.providers ?? []}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta
                          title={item.name}
                          description={
                            <Typography.Paragraph style={{ marginBottom: 0 }}>
                              {item.description}
                              <br />
                              <Typography.Text type="secondary">
                                {Object.entries(item.stats ?? {})
                                  .map(([key, value]) => `${key}: ${value}`)
                                  .join(' · ') || 'first-party module'}
                              </Typography.Text>
                            </Typography.Paragraph>
                          }
                        />
                        <Tag color={item.status?.reachable ? 'green' : 'default'}>
                          {item.status?.reachable ? 'active' : 'inactive'}
                        </Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard" title="V1.1 已交付模块">
                <div className="panel-subcard__content">
                  <List
                    dataSource={[
                      '用户登录与基础角色控制',
                      '主机纳管与环境画像',
                      '服务自动发现与统一展示',
                      '内建监控内核与历史曲线',
                      '内建风险策略与审批门禁',
                      'Goal-driven 任务中心',
                      '审批中心与审计日志',
                      '浏览器语音输入与结论播报',
                    ]}
                    renderItem={(item) => <List.Item>{item}</List.Item>}
                  />
                </div>
              </Card>
            </div>

            <div className="panel-subgrid panel-subgrid--2">
              <Card type="inner" className="panel-subcard resizable-subcard" title="PDF 要求覆盖">
                <div className="panel-subcard__content">
                  <List
                    dataSource={validation?.items ?? []}
                    renderItem={(item: any) => (
                      <List.Item>
                        <List.Item.Meta title={item.requirement} description={item.evidence} />
                        <Tag color={item.status === 'pass' ? 'green' : 'gold'}>{item.status}</Tag>
                      </List.Item>
                    )}
                  />
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard" title="注意事项">
                <div className="panel-subcard__content">
                  <Typography.Paragraph>
                    Claude Agent SDK 仍然是中央控制平面的编排层。基础监控、策略控制和服务发现已经收回到项目自身的内建模块中，
                    当前产品对外不再依赖独立的第三方控制台作为主能力入口。
                  </Typography.Paragraph>
                </div>
              </Card>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
