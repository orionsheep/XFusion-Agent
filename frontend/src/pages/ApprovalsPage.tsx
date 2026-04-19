import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Input, Modal, Space, Statistic, Table, Tag, Typography, message } from 'antd'
import { useState } from 'react'
import { ExpandablePanelCard } from '../components/ExpandablePanelCard'
import { decideApproval, fetchApprovals } from '../services/api'

export function ApprovalsPage() {
  const [messageApi, contextHolder] = message.useMessage()
  const queryClient = useQueryClient()
  const [currentApproval, setCurrentApproval] = useState<any>()
  const [reason, setReason] = useState('')

  const { data = [], isLoading } = useQuery({
    queryKey: ['approvals'],
    queryFn: fetchApprovals,
    refetchInterval: 5000,
  })

  const mutation = useMutation({
    mutationFn: ({ approvalId, approved }: { approvalId: number; approved: boolean }) =>
      decideApproval(approvalId, approved, reason),
    onSuccess: () => {
      messageApi.success('审批已处理')
      queryClient.invalidateQueries({ queryKey: ['approvals'] })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      setCurrentApproval(undefined)
      setReason('')
    },
  })

  const pendingCount = data.filter((item: any) => item.status === 'pending').length

  return (
    <div className="page-shell">
      {contextHolder}
      <div className="page-shell__header">
        <h1 className="page-title">审批中心</h1>
        <p className="page-subtitle">所有高风险动作都必须在这里完成最终放行。</p>
      </div>
      <div className="page-shell__body">
        <ExpandablePanelCard className="panel-card resizable-card" title="审批工作台" fullscreenLabel="审批工作台">
          <div className="panel-card__content">
            <div className="panel-subgrid panel-subgrid--2">
              <Card type="inner" className="panel-subcard resizable-subcard" title="审批概览">
                <div className="panel-subcard__content">
                  <Space wrap>
                    <Tag color="gold">待审批 {pendingCount}</Tag>
                    <Tag>总审批单 {data.length}</Tag>
                  </Space>
                  <Statistic title="待处理审批单" value={pendingCount} />
                </div>
              </Card>

              <Card type="inner" className="panel-subcard resizable-subcard" title="审批说明">
                <div className="panel-subcard__content">
                  <Typography.Text>所有高风险动作都必须经人工确认后才能继续执行。</Typography.Text>
                  <Typography.Text>审批结果会同步影响任务时间线和审计日志。</Typography.Text>
                </div>
              </Card>
            </div>

            <Card type="inner" className="panel-subcard resizable-subcard" title="审批列表">
              <div className="panel-subcard__content">
                <div className="table-scroll">
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    dataSource={data}
                    scroll={{ x: 760 }}
                    columns={[
                      { title: '审批单', dataIndex: 'id' },
                      { title: '任务', dataIndex: 'task_id' },
                      {
                        title: '状态',
                        dataIndex: 'status',
                        render: (value: string) => <Tag color={value === 'pending' ? 'gold' : 'green'}>{value}</Tag>,
                      },
                      {
                        title: '动作',
                        render: (_: unknown, record: any) => (
                          <Space>
                            <Button disabled={record.status !== 'pending'} onClick={() => setCurrentApproval(record)}>
                              审批
                            </Button>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </div>
              </div>
            </Card>
          </div>
        </ExpandablePanelCard>
      </div>

      <Modal
        open={Boolean(currentApproval)}
        onCancel={() => setCurrentApproval(undefined)}
        title={`审批 #${currentApproval?.id}`}
        footer={null}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <Typography.Paragraph>
            <strong>拟执行动作：</strong>
            <br />
            {JSON.stringify(currentApproval?.action_payload ?? {}, null, 2)}
          </Typography.Paragraph>
          <Input.TextArea
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="填写审批原因或拒绝原因"
          />
          <Space>
            <Button
              type="primary"
              loading={mutation.isPending}
              onClick={() =>
                mutation.mutate({ approvalId: currentApproval.id, approved: true })
              }
            >
              批准
            </Button>
            <Button
              danger
              loading={mutation.isPending}
              onClick={() =>
                mutation.mutate({ approvalId: currentApproval.id, approved: false })
              }
            >
              拒绝
            </Button>
          </Space>
        </Space>
      </Modal>
    </div>
  )
}
