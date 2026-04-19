import { ArrowsAltOutlined, ShrinkOutlined } from '@ant-design/icons'
import { Button, Card, Space } from 'antd'
import type { CardProps } from 'antd'
import { useEffect, useState } from 'react'

type ExpandablePanelCardProps = CardProps & {
  fullscreenLabel?: string
}

export function ExpandablePanelCard({
  extra,
  className,
  fullscreenLabel,
  ...props
}: ExpandablePanelCardProps) {
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [fullscreen])

  const expandButton = (
    <Button
      size="small"
      type="text"
      aria-label={fullscreen ? `退出${fullscreenLabel ?? '全屏'}` : `展开${fullscreenLabel ?? '全屏'}`}
      icon={fullscreen ? <ShrinkOutlined /> : <ArrowsAltOutlined />}
      onClick={() => setFullscreen((value) => !value)}
    />
  )

  const mergedExtra = extra ? <Space size={8}>{extra}{expandButton}</Space> : expandButton

  return (
    <div className={`expandable-panel-card-shell${fullscreen ? ' expandable-panel-card-shell--fullscreen' : ''}`}>
      {fullscreen ? <div className="expandable-panel-card__backdrop" onClick={() => setFullscreen(false)} /> : null}
      <Card
        {...props}
        extra={mergedExtra}
        className={`${className ?? ''}${fullscreen ? ' expandable-panel-card--fullscreen' : ''}`.trim()}
      />
    </div>
  )
}
