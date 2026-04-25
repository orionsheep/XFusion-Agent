import {
  DeleteOutlined,
  DownloadOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Breadcrumb,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import {
  createRemoteDirectory,
  deleteRemoteFile,
  downloadRemoteFile,
  fetchHosts,
  listRemoteFiles,
  uploadRemoteFile,
} from '../services/api'

type RemoteFileEntry = {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink' | 'other' | 'unknown'
  size?: number | null
  permissions?: string
  owner?: string | null
  group?: string | null
  mtime?: number | null
}

const PROTECTED_DELETE_PATHS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
])

function parentPath(path: string) {
  if (!path || path === '/') return '/'
  const normalized = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

function isTopLevelPath(path: string) {
  if (!path || path === '/') return false
  const normalized = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
  return parentPath(normalized) === '/'
}

function joinPath(directory: string, name: string) {
  const base = directory === '/' ? '' : directory.replace(/\/$/, '')
  return `${base}/${name}`.replace(/\/+/g, '/')
}

function formatBytes(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function formatUnixTime(value?: number | null) {
  if (!value) return '-'
  return new Date(value * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function pathBreadcrumb(path: string) {
  const normalized = path || '/'
  const parts = normalized.split('/').filter(Boolean)
  const items = [{ title: '/', path: '/' }]
  let cursor = ''
  parts.forEach((part) => {
    cursor = `${cursor}/${part}`
    items.push({ title: part, path: cursor })
  })
  return items
}

export function FileManagerPage() {
  const [messageApi, contextHolder] = message.useMessage()
  const queryClient = useQueryClient()
  const [selectedHostId, setSelectedHostId] = useState<number>()
  const [currentPath, setCurrentPath] = useState('/')
  const [pathDraft, setPathDraft] = useState('/')
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [newDirectoryName, setNewDirectoryName] = useState('')

  const { data: hosts = [] } = useQuery({
    queryKey: ['hosts'],
    queryFn: fetchHosts,
  })

  useEffect(() => {
    if (!selectedHostId && hosts.length) {
      const onlineHost = hosts.find((host: any) => ['online', 'registered'].includes(String(host.status).toLowerCase()))
      setSelectedHostId(Number((onlineHost ?? hosts[0]).id))
    }
  }, [hosts, selectedHostId])

  useEffect(() => {
    setPathDraft(currentPath)
  }, [currentPath])

  const selectedHost = hosts.find((host: any) => Number(host.id) === Number(selectedHostId))

  const filesQuery = useQuery({
    queryKey: ['remote-files', selectedHostId, currentPath],
    queryFn: () => listRemoteFiles(Number(selectedHostId), currentPath),
    enabled: Boolean(selectedHostId),
    staleTime: 5_000,
  })

  const entries = useMemo<RemoteFileEntry[]>(
    () => filesQuery.data?.entries ?? [],
    [filesQuery.data?.entries],
  )

  const refreshFiles = () => {
    queryClient.invalidateQueries({ queryKey: ['remote-files', selectedHostId] })
  }

  const mkdirMutation = useMutation({
    mutationFn: () => createRemoteDirectory(Number(selectedHostId), joinPath(currentPath, newDirectoryName.trim())),
    onSuccess: () => {
      messageApi.success('目录已创建')
      setMkdirOpen(false)
      setNewDirectoryName('')
      refreshFiles()
    },
    onError: (error: any) => messageApi.error(error?.response?.data?.detail ?? '创建目录失败'),
  })

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadRemoteFile(Number(selectedHostId), currentPath, file, true),
    onSuccess: () => {
      messageApi.success('文件已上传')
      refreshFiles()
    },
    onError: (error: any) => messageApi.error(error?.response?.data?.detail ?? '上传失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: (entry: RemoteFileEntry) => deleteRemoteFile(Number(selectedHostId), entry.path, entry.type === 'directory'),
    onSuccess: () => {
      messageApi.success('已删除')
      refreshFiles()
    },
    onError: (error: any) => messageApi.error(error?.response?.data?.detail ?? '删除失败'),
  })

  const downloadFile = async (entry: RemoteFileEntry) => {
    try {
      const blob = await downloadRemoteFile(Number(selectedHostId), entry.path)
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = entry.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch (error: any) {
      messageApi.error(error?.response?.data?.detail ?? '下载失败')
    }
  }

  const submitPath = () => {
    const nextPath = pathDraft.trim() || '/'
    setCurrentPath(nextPath.startsWith('/') || nextPath.startsWith('~') ? nextPath : `/${nextPath}`)
  }

  return (
    <div className="file-manager-page">
      {contextHolder}
      <Card className="panel-card file-manager-hero">
        <div>
          <Typography.Text className="page-kicker">REMOTE FILES</Typography.Text>
          <Typography.Title level={3} style={{ margin: '4px 0 0' }}>
            服务器文件管理
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
            通过 SSH/SFTP 浏览目标主机目录，并在本机与服务器之间上传、下载和整理文件。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 220 }}
            placeholder="选择目标主机"
            value={selectedHostId}
            options={hosts.map((host: any) => ({
              value: Number(host.id),
              label: `${host.name} · ${host.address} · ${host.status ?? 'unknown'}`,
            }))}
            onChange={(value) => {
              setSelectedHostId(Number(value))
              setCurrentPath('/')
            }}
          />
          <Tag color={selectedHost?.status === 'online' || selectedHost?.status === 'registered' ? 'green' : 'default'}>
            {selectedHost?.status ?? 'unknown'}
          </Tag>
        </Space>
      </Card>

      <Card className="panel-card file-manager-shell">
        <div className="file-manager-toolbar">
          <Space.Compact className="file-manager-pathbar">
            <Button disabled={currentPath === '/'} onClick={() => setCurrentPath(parentPath(currentPath))}>
              上一级
            </Button>
            <Input
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              onPressEnter={submitPath}
            />
            <Button type="primary" onClick={submitPath}>
              打开
            </Button>
          </Space.Compact>
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={filesQuery.isFetching} onClick={refreshFiles}>
              刷新
            </Button>
            <Button icon={<FolderAddOutlined />} onClick={() => setMkdirOpen(true)}>
              新建目录
            </Button>
            <Upload
              showUploadList={false}
              beforeUpload={(file) => {
                uploadMutation.mutate(file)
                return false
              }}
            >
              <Button icon={<UploadOutlined />} loading={uploadMutation.isPending}>
                上传文件
              </Button>
            </Upload>
          </Space>
        </div>

        <Breadcrumb
          className="file-manager-breadcrumb"
          items={pathBreadcrumb(currentPath).map((item) => ({
            title: (
              <button type="button" onClick={() => setCurrentPath(item.path)}>
                {item.title}
              </button>
            ),
          }))}
        />

        <Table<RemoteFileEntry>
          rowKey="path"
          loading={filesQuery.isFetching}
          dataSource={entries}
          locale={{
            emptyText: filesQuery.isError ? (
              <Empty description="目录读取失败，请检查 SSH/SFTP 权限或主机在线状态" />
            ) : (
              <Empty description="当前目录为空" />
            ),
          }}
          pagination={{ pageSize: 14, showSizeChanger: false }}
          onRow={(record) => ({
            onDoubleClick: () => {
              if (record.type === 'directory') setCurrentPath(record.path)
            },
          })}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (value: string, record) => (
                <button
                  type="button"
                  className="file-manager-name"
                  onClick={() => {
                    if (record.type === 'directory') setCurrentPath(record.path)
                  }}
                >
                  {record.type === 'directory' ? <FolderOpenOutlined /> : <FileOutlined />}
                  <span>{value}</span>
                </button>
              ),
            },
            {
              title: '类型',
              dataIndex: 'type',
              width: 130,
              render: (value: string) => <Tag color={value === 'directory' ? 'green' : 'blue'}>{value}</Tag>,
            },
            {
              title: '大小',
              dataIndex: 'size',
              width: 130,
              render: formatBytes,
            },
            {
              title: '权限',
              dataIndex: 'permissions',
              width: 150,
              render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
            },
            {
              title: '修改时间',
              dataIndex: 'mtime',
              width: 150,
              render: formatUnixTime,
            },
            {
              title: '操作',
              width: 210,
              render: (_, record) => {
                const deleteDisabled = PROTECTED_DELETE_PATHS.has(record.path) || isTopLevelPath(record.path)
                return (
                  <Space size={6}>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      disabled={record.type === 'directory'}
                      onClick={() => downloadFile(record)}
                    >
                      下载
                    </Button>
                    <Popconfirm
                      title="确认删除远程文件？"
                      description={record.type === 'directory' ? '目录会递归删除，请确认不是系统关键目录。' : record.path}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      disabled={deleteDisabled}
                      onConfirm={() => deleteMutation.mutate(record)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={deleteDisabled}
                        loading={deleteMutation.isPending}
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                )
              },
            },
          ]}
        />
      </Card>

      <Modal
        title="新建远程目录"
        open={mkdirOpen}
        okText="创建"
        cancelText="取消"
        confirmLoading={mkdirMutation.isPending}
        onOk={() => {
          if (!newDirectoryName.trim()) {
            messageApi.warning('请输入目录名称')
            return
          }
          mkdirMutation.mutate()
        }}
        onCancel={() => setMkdirOpen(false)}
      >
        <Typography.Paragraph type="secondary">
          将在 <Typography.Text code>{currentPath}</Typography.Text> 下创建目录。
        </Typography.Paragraph>
        <Input
          autoFocus
          placeholder="例如 logs-backup"
          value={newDirectoryName}
          onChange={(event) => setNewDirectoryName(event.target.value)}
          onPressEnter={() => mkdirMutation.mutate()}
        />
      </Modal>
    </div>
  )
}
