import { useQuery } from '@tanstack/react-query'
import { Card, Statistic, Table, Tag } from 'antd'
import dayjs from 'dayjs'
import { fetchAudit } from '../services/api'

export function AuditPage() {
  const { data = [], isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: fetchAudit,
  })

  const hostTouched = new Set(data.map((item: any) => item.host_id).filter(Boolean)).size
  const taskTouched = new Set(data.map((item: any) => item.task_id).filter(Boolean)).size

  return (
    <div className="page-shell">
      <div className="page-shell__header">
        <h1 className="page-title">审计日志</h1>
        <p className="page-subtitle">所有关键行为都在这里留存时间线和上下文。</p>
      </div>
      <div className="page-shell__body">
        <Card className="panel-card resizable-card" title="审计中心">
          <div className="panel-card__content">
            <div className="panel-subgrid panel-subgrid--3">
              <Card type="inner" className="panel-subcard resizable-subcard" title="事件总量">
                <div className="panel-subcard__content">
                  <Statistic title="审计事件" value={data.length} />
                </div>
              </Card>
              <Card type="inner" className="panel-subcard resizable-subcard" title="涉及任务">
                <div className="panel-subcard__content">
                  <Statistic title="任务数量" value={taskTouched} />
                </div>
              </Card>
              <Card type="inner" className="panel-subcard resizable-subcard" title="涉及主机">
                <div className="panel-subcard__content">
                  <Statistic title="主机数量" value={hostTouched} />
                </div>
              </Card>
            </div>

            <Card type="inner" className="panel-subcard resizable-subcard" title="审计明细">
              <div className="panel-subcard__content">
                <div className="table-scroll">
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    dataSource={data}
                    scroll={{ x: 1120 }}
                    columns={[
                      { title: 'ID', dataIndex: 'id' },
                      { title: '事件', dataIndex: 'event_type', render: (value: string) => <Tag>{value}</Tag> },
                      { title: '任务', dataIndex: 'task_id' },
                      { title: '主机', dataIndex: 'host_id' },
                      {
                        title: '时间',
                        dataIndex: 'created_at',
                        render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
                      },
                      {
                        title: '详情',
                        dataIndex: 'payload_json',
                        render: (value: unknown) => (
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', maxWidth: 480 }}>{JSON.stringify(value, null, 2)}</pre>
                        ),
                      },
                    ]}
                  />
                </div>
              </div>
            </Card>
          </div>
        </Card>
      </div>
    </div>
  )
}
