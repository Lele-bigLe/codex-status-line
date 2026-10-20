import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  CAPSULE_WINDOW_SIZE,
  selectPrimaryRateLimit,
  type AppSettings,
  type CapsuleDragMovePayload,
  type UsageSnapshot,
  type WindowPreferences
} from '../../../shared/capsule'
import { COPY } from '../copy'
import {
  formatAbsoluteDate,
  formatCapsuleResetTime,
  getUsageStatus,
  resolveMetricTone
} from '../usagePresentation'
import { ChevronRightIcon } from './Icons'

const CAPSULE_CLICK_DRAG_DISTANCE = 5
const MANUAL_REFRESH_FEEDBACK_MS = 680

interface CapsulePointerState {
  pointerId: number
  originScreenX: number
  originScreenY: number
  offsetX: number
  offsetY: number
  hasDragged: boolean
}

export function CapsuleWindow({
  settings,
  snapshot,
  windowPreferences,
  now,
  onPreferencesChange,
  onRefresh,
  onIssue
}: {
  settings: AppSettings
  snapshot: UsageSnapshot
  windowPreferences: WindowPreferences
  now: number
  onPreferencesChange: (preferences: WindowPreferences) => void
  onRefresh: () => Promise<void>
  onIssue: (error: unknown) => void
}): React.JSX.Element {
  const [pointerActive, setPointerActive] = useState(false)
  const [manualRefreshActive, setManualRefreshActive] = useState(false)
  const pointerRef = useRef<CapsulePointerState | null>(null)
  const dragFrameRef = useRef<number | undefined>(undefined)
  const pendingDragRef = useRef<CapsuleDragMovePayload | undefined>(undefined)
  const dragRequestRef = useRef<Promise<void> | undefined>(undefined)
  const dragFinishingRef = useRef(false)
  const manualRefreshTimerRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (dragFrameRef.current !== undefined) window.cancelAnimationFrame(dragFrameRef.current)
      pendingDragRef.current = undefined
      if (manualRefreshTimerRef.current !== undefined)
        window.clearTimeout(manualRefreshTimerRef.current)
    },
    []
  )

  const copy = COPY[settings.locale]
  const { isStale, statusLabel } = getUsageStatus(snapshot, settings, now)
  const canRefresh = snapshot.canRefresh !== false
  const primaryWindow = selectPrimaryRateLimit(snapshot.rateLimits)
  const displayPercent =
    settings.percentageMode === 'used'
      ? primaryWindow?.usedPercent
      : primaryWindow?.remainingPercent
  const tone = resolveMetricTone(displayPercent, settings.percentageMode)
  const className = [
    'capsule',
    `capsule--${windowPreferences.viewMode}`,
    `capsule--${tone}`,
    snapshot.isRefreshing ? 'is-refreshing' : '',
    manualRefreshActive ? 'is-manual-refreshing' : '',
    canRefresh ? '' : 'is-static',
    isStale ? 'is-stale' : '',
    pointerActive ? 'is-dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')

  function refresh(): void {
    if (!canRefresh || snapshot.isRefreshing) return
    setManualRefreshActive(true)
    if (manualRefreshTimerRef.current !== undefined)
      window.clearTimeout(manualRefreshTimerRef.current)
    manualRefreshTimerRef.current = window.setTimeout(() => {
      setManualRefreshActive(false)
      manualRefreshTimerRef.current = undefined
    }, MANUAL_REFRESH_FEEDBACK_MS)
    void onRefresh()
  }

  function handlePointerDown(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0 || dragFinishingRef.current || pointerRef.current) return
    const bounds = event.currentTarget.getBoundingClientRect()
    pointerRef.current = {
      pointerId: event.pointerId,
      originScreenX: event.screenX,
      originScreenY: event.screenY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      hasDragged: false
    }
    setPointerActive(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>): void {
    const pointerState = pointerRef.current
    if (!pointerState || pointerState.pointerId !== event.pointerId) return
    const distance = Math.hypot(
      event.screenX - pointerState.originScreenX,
      event.screenY - pointerState.originScreenY
    )
    if (distance < CAPSULE_CLICK_DRAG_DISTANCE && !pointerState.hasDragged) return
    pointerState.hasDragged = true
    event.preventDefault()
    pendingDragRef.current = {
      screenX: event.screenX,
      screenY: event.screenY,
      offsetX: pointerState.offsetX,
      offsetY: pointerState.offsetY
    }
    scheduleDragMove()
  }

  function scheduleDragMove(): void {
    if (dragFrameRef.current !== undefined || dragRequestRef.current) return
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = undefined
      const payload = pendingDragRef.current
      pendingDragRef.current = undefined
      if (!payload) return
      // 每帧只发最新位置，且最多一个在途请求；移动坐标无需驱动 React 渲染。
      dragRequestRef.current = window.codexStatus
        .moveCapsuleWindow(payload)
        .then(() => undefined)
        .catch(onIssue)
        .finally(() => {
          dragRequestRef.current = undefined
          if (pendingDragRef.current && !dragFinishingRef.current) scheduleDragMove()
        })
    })
  }

  async function finishPointer(
    event: React.PointerEvent<HTMLElement>,
    shouldRefreshOnClick: boolean
  ): Promise<void> {
    const pointerState = pointerRef.current
    if (!pointerState || pointerState.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    pointerRef.current = null
    setPointerActive(false)
    if (pointerState.hasDragged) {
      dragFinishingRef.current = true
      if (dragFrameRef.current !== undefined) window.cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = undefined
      if (shouldRefreshOnClick) {
        pendingDragRef.current = {
          screenX: event.screenX,
          screenY: event.screenY,
          offsetX: pointerState.offsetX,
          offsetY: pointerState.offsetY
        }
      }
      try {
        await dragRequestRef.current
        const payload = pendingDragRef.current
        pendingDragRef.current = undefined
        if (payload) await window.codexStatus.moveCapsuleWindow(payload).catch(onIssue)
        onPreferencesChange(await window.codexStatus.finishCapsuleWindowDrag())
      } catch (error) {
        onIssue(error)
      } finally {
        dragFinishingRef.current = false
      }
      return
    }
    if (shouldRefreshOnClick) refresh()
  }

  return (
    <div className="app-shell app-shell--capsule" data-theme={settings.theme}>
      <main
        className={`widget widget--${windowPreferences.viewMode}`}
        style={
          {
            '--status-bar-width': `${CAPSULE_WINDOW_SIZE.width}px`,
            '--status-bar-height': `${CAPSULE_WINDOW_SIZE.height}px`,
            zoom: settings.capsuleScale / 100
          } as CSSProperties
        }
      >
        <section
          aria-label={`${statusLabel}. ${settings.percentageMode === 'used' ? copy.used : copy.remaining}. ${snapshot.rateLimits.map((window) => `${window.label} ${(settings.percentageMode === 'used' ? window.usedPercent : window.remainingPercent) ?? '--'}%`).join(', ')}. ${copy.refresh}`}
          aria-busy={snapshot.isRefreshing}
          title={`${snapshot.account?.label ?? copy.unknownAccount} · ${statusLabel}\n${settings.percentageMode === 'used' ? copy.used : copy.remaining}\n${copy.capsuleHint}`}
          className={className}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && canRefresh) {
              event.preventDefault()
              refresh()
            }
          }}
          onPointerCancel={(event) => {
            void finishPointer(event, false)
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => {
            void finishPointer(event, true)
          }}
          role={canRefresh ? 'button' : undefined}
          tabIndex={canRefresh ? 0 : -1}
        >
          <div className="status-line" aria-hidden="true">
            <strong>{primaryWindow?.label ?? '--'}</strong>
            <span className="status-line__separator">|</span>
            <span title={formatAbsoluteDate(primaryWindow?.resetsAt, settings.locale)}>
              {formatCapsuleResetTime(primaryWindow?.resetsAt, settings.locale)}
            </span>
            <span className="status-line__separator">|</span>
            <strong className="status-line__value">
              {displayPercent === undefined ? '--' : `${Math.round(displayPercent)}%`}
            </strong>
          </div>
        </section>
        <button
          className="capsule__details"
          type="button"
          aria-label={copy.details}
          title={copy.details}
          onClick={() => {
            void window.codexStatus.openPanel().catch(onIssue)
          }}
        >
          <ChevronRightIcon />
        </button>
      </main>
    </div>
  )
}
