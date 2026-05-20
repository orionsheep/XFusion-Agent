import {
  ClearOutlined,
  CodeOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Button, Card, Input, Select, Space, Switch, Tag, Typography, message } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import { executeTerminalCommand, fetchHosts } from '../services/api'

type TerminalEntry = {
  id: string
  command: string
  cwd: string
  hostName: string
  safeMode: boolean
  success?: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  createdAt: string
  running?: boolean
}

function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function TerminalPage() {
  const [messageApi, contextHolder] = message.useMessage()
  const outputRef = useRef<HTMLDivElement | null>(null)
  const [selectedHostId, setSelectedHostId] = useState<number>()
  const [cwd, setCwd] = useState('/')
  const [command, setCommand] = useState('pwd && whoami && uptime')
  const [safeMode, setSafeMode] = useState(true)
  const [entries, setEntries] = useState<TerminalEntry[]>([])

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
    const node = outputRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [entries])

  const selectedHost = useMemo(
    () => hosts.find((host: any) => Number(host.id) === Number(selectedHostId)),
    [hosts, selectedHostId],
  )

  const commandMutation = useMutation({
    mutationFn: (payload: { entryId: string; hostId: number; command: string; cwd: string; safeMode: boolean }) =>
      executeTerminalCommand(payload.hostId, {
        command: payload.command,
        cwd: payload.cwd,
        safe_mode: payload.safeMode,
        timeout_seconds: 30,
      }).then((result) => ({ result, entryId: payload.entryId })),
    onSuccess: ({ result, entryId }) => {
      setEntries((current) => current.map((entry) => (
        entry.id === entryId
          ? {
            ...entry,
            running: false,
            success: Boolean(result.success),
            exitCode: Number(result.exit_code),
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
          }
          : entry
      )))
    },
    onError: (error: any, variables) => {
      const detail = error?.response?.data?.detail ?? '命令执行失败'
      setEntries((current) => current.map((entry) => (
        entry.id === variables.entryId
          ? {
            ...entry,
            running: false,
            success: false,
            exitCode: error?.response?.status ?? 1,
            stderr: detail,
          }
          : entry
      )))
      messageApi.error(detail)
    },
  })

  const runCommand = () => {
    const nextCommand = command.trim()
    if (!selectedHostId) {
      messageApi.warning('请选择目标主机')
      return
    }
    if (!nextCommand) {
      messageApi.warning('请输入命令')
      return
    }
    const entryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const entry: TerminalEntry = {
      id: entryId,
      command: nextCommand,
      cwd,
      hostName: selectedHost?.name ?? `host-${selectedHostId}`,
      safeMode,
      createdAt: nowLabel(),
      running: true,
    }
    setEntries((current) => [...current, entry])
    commandMutation.mutate({
      entryId,
      hostId: Number(selectedHostId),
      command: nextCommand,
      cwd,
      safeMode,
    })
  }

  return (
    <div className="terminal-page">
      {contextHolder}
      <Card className="panel-card terminal-hero">
        <div>
          <Typography.Text className="page-kicker">REMOTE TERMINAL</Typography.Text>
          <Typography.Title level={3} style={{ margin: '4px 0 0' }}>
            服务器 Terminal
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
            面向传统运维习惯的 SSH 命令面板。默认安全模式只允许只读排查命令，关闭后由管理员直接承担执行风险。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 260 }}
            placeholder="选择目标主机"
            value={selectedHostId}
            options={hosts.map((host: any) => ({
              value: Number(host.id),
              label: `${host.name} · ${host.address} · ${host.status ?? 'unknown'}`,
            }))}
            onChange={(value) => setSelectedHostId(Number(value))}
          />
          <Tag color={selectedHost?.status === 'online' || selectedHost?.status === 'registered' ? 'green' : 'default'}>
            {selectedHost?.status ?? 'unknown'}
          </Tag>
        </Space>
      </Card>

      <Card className="panel-card terminal-shell">
        <div className="terminal-toolbar">
          <Space wrap>
            <Input
              className="terminal-cwd"
              prefix="cwd"
              value={cwd}
              onChange={(event) => setCwd(event.target.value || '/')}
              onPressEnter={runCommand}
            />
            <span className="terminal-safe-switch">
              <SafetyCertificateOutlined />
              <span>安全模式</span>
              <Switch checked={safeMode} onChange={setSafeMode} />
            </span>
          </Space>
          <Space wrap>
            <Button icon={<ClearOutlined />} onClick={() => setEntries([])}>
              清屏
            </Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={commandMutation.isPending}
              onClick={runCommand}
            >
              执行
            </Button>
          </Space>
        </div>

        <div ref={outputRef} className="terminal-output" aria-label="Terminal 输出">
          {entries.length ? entries.map((entry) => (
            <section key={entry.id} className={`terminal-entry${entry.running ? ' is-running' : ''}`}>
              <div className="terminal-entry__meta">
                <span>{entry.createdAt}</span>
                <Tag color={entry.running ? 'blue' : entry.success ? 'green' : 'red'}>
                  {entry.running ? 'running' : entry.success ? 'exit 0' : `exit ${entry.exitCode ?? '-'}`}
                </Tag>
                <Tag color={entry.safeMode ? 'green' : 'volcano'}>{entry.safeMode ? 'safe' : 'unsafe'}</Tag>
                <span>{entry.hostName}</span>
                <span>{entry.cwd}</span>
              </div>
              <pre className="terminal-entry__command"><CodeOutlined /> {entry.command}</pre>
              {entry.running ? <div className="terminal-entry__loading">正在等待远程命令返回...</div> : null}
              {entry.stdout ? <pre className="terminal-entry__stdout">{entry.stdout}</pre> : null}
              {entry.stderr ? <pre className="terminal-entry__stderr">{entry.stderr}</pre> : null}
              {!entry.running && !entry.stdout && !entry.stderr ? <pre className="terminal-entry__stdout">(no output)</pre> : null}
            </section>
          )) : (
            <div className="terminal-empty">
              <CodeOutlined />
              <strong>等待命令</strong>
              <span>输入命令后按 Enter 或点击执行。建议先从 `pwd`、`df -h`、`pm2 list`、`systemctl status xxx` 开始。</span>
            </div>
          )}
        </div>

        <div className="terminal-input-row">
          <span className="terminal-prompt">{selectedHost?.name ?? 'host'}:{cwd || '/'} $</span>
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 4 }}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault()
                runCommand()
              }
            }}
            placeholder="输入命令，例如：df -h 或 pm2 list"
          />
        </div>
      </Card>
    </div>
  )
}
