import { ArrowsAltOutlined, FullscreenExitOutlined, FullscreenOutlined, ShrinkOutlined } from '@ant-design/icons'
import { Button, Card, Space } from 'antd'
import type { CardProps } from 'antd'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type ExpandablePanelCardProps = CardProps & {
  fullscreenLabel?: string
}

export function ExpandablePanelCard({
  extra,
  className,
  fullscreenLabel,
  children,
  ...props
}: ExpandablePanelCardProps) {
  const [fullscreen, setFullscreen] = useState(false)
  const [pageFullscreen, setPageFullscreen] = useState(false)

  useEffect(() => {
    if (!pageFullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [pageFullscreen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPageFullscreen(false)
        setFullscreen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const togglePageFullscreen = () => {
    setPageFullscreen((value) => !value)
  }

  const expandButton = (
    <Button
      size="small"
      type="text"
      aria-label={fullscreen ? `退出${fullscreenLabel ?? '全屏'}` : `展开${fullscreenLabel ?? '全屏'}`}
      icon={fullscreen ? <ShrinkOutlined /> : <ArrowsAltOutlined />}
      onClick={() => setFullscreen((value) => !value)}
    />
  )

  const pageFullscreenButton = (
    <Button
      size="small"
      type="text"
      aria-label={pageFullscreen ? '退出网页全屏' : '进入网页全屏'}
      title={pageFullscreen ? '退出网页全屏' : '进入网页全屏'}
      icon={pageFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
      onClick={togglePageFullscreen}
    />
  )

  const mergedExtra = extra ? <Space size={8}>{extra}{pageFullscreenButton}{expandButton}</Space> : <Space size={8}>{pageFullscreenButton}{expandButton}</Space>

  const cardNode = (
    <Card
      {...props}
      extra={mergedExtra}
      className={`${className ?? ''}${fullscreen || pageFullscreen ? ' expandable-panel-card--fullscreen' : ''}`.trim()}
    >
      {children}
    </Card>
  )

  if (pageFullscreen && typeof document !== 'undefined') {
    return createPortal(
      <div className="expandable-panel-card-shell expandable-panel-card-shell--page-fullscreen">
        <div className="expandable-panel-card__backdrop" onClick={() => setPageFullscreen(false)} />
        {cardNode}
      </div>,
      document.body,
    )
  }

  return (
    <div className={`expandable-panel-card-shell${fullscreen ? ' expandable-panel-card-shell--panel-fullscreen' : ''}`}>
      {fullscreen ? <div className="expandable-panel-card__backdrop" onClick={() => setFullscreen(false)} /> : null}
      {cardNode}
    </div>
  )
}
