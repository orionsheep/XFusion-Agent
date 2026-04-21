import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'

const SESSION_STORAGE_KEY = 'xfusion_agent_session_id'
const HOSTS_STORAGE_KEY = 'xfusion_agent_selected_hosts'

type AgentConsoleContextValue = {
  prompt: string
  setPrompt: (value: string) => void
  sessionId: string
  setSessionId: (value: string) => void
  selectedHosts: number[]
  setSelectedHosts: (value: number[]) => void
  routePinnedHostId: number | null
  setRoutePinnedHostId: (value: number | null) => void
  drawerOpen: boolean
  setDrawerOpen: (value: boolean) => void
  createNewConversation: () => void
}

const AgentConsoleContext = createContext<AgentConsoleContextValue | null>(null)

function buildSessionId() {
  return `agent-${Date.now().toString(36)}`
}

function getStoredSessionId() {
  if (typeof window === 'undefined') return buildSessionId()
  const stored = window.localStorage.getItem(SESSION_STORAGE_KEY)
  if (!stored || stored === 'console-main') return buildSessionId()
  return stored
}

function getStoredSelectedHosts() {
  if (typeof window === 'undefined') return [] as number[]
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HOSTS_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value) => Number.isFinite(value)) : []
  } catch {
    return []
  }
}

export function AgentConsoleProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState(getStoredSessionId)
  const [selectedHosts, setSelectedHosts] = useState<number[]>(getStoredSelectedHosts)
  const [routePinnedHostId, setRoutePinnedHostId] = useState<number | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  }, [sessionId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(selectedHosts))
  }, [selectedHosts])

  useEffect(() => {
    const match = location.pathname.match(/^\/hosts\/(\d+)$/)
    if (!match) {
      if (routePinnedHostId !== null) {
        setRoutePinnedHostId(null)
      }
      return
    }
    const hostId = Number(match[1])
    if (Number.isFinite(hostId)) {
      setSelectedHosts([hostId])
      setRoutePinnedHostId(hostId)
    }
  }, [location.pathname, routePinnedHostId])

  const value = useMemo<AgentConsoleContextValue>(() => ({
    prompt,
    setPrompt,
    sessionId,
    setSessionId,
    selectedHosts,
    setSelectedHosts,
    routePinnedHostId,
    setRoutePinnedHostId,
    drawerOpen,
    setDrawerOpen,
    createNewConversation: () => {
      setSessionId(buildSessionId())
      setPrompt('')
    },
  }), [drawerOpen, prompt, routePinnedHostId, selectedHosts, sessionId])

  return (
    <AgentConsoleContext.Provider value={value}>
      {children}
    </AgentConsoleContext.Provider>
  )
}

export function useAgentConsole() {
  const context = useContext(AgentConsoleContext)
  if (!context) {
    throw new Error('useAgentConsole must be used within AgentConsoleProvider')
  }
  return context
}
