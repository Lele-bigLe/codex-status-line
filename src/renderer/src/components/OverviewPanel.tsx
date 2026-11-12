import type { CSSProperties } from 'react'
import type {
  AppSettings,
  LocaleCode,
  PercentageMode,
  RateLimitWindowSnapshot,
  UsageSnapshot
} from '../../../shared/capsule'
import { COPY } from '../copy'
import {
  formatAbsoluteDate,
  formatRelativeDate,
  formatRelativeDuration,
  getUsageStatus,
  resolveMetricTone
} from '../usagePresentation'
import { AutomationPanel } from './AutomationPanel'
import { AlertIcon, ClockIcon, HistoryIcon } from './Icons'
import { GlassMaterial } from './GlassMaterial'

export function OverviewPanel({
  automation,
  settings,
  snapshot,
  now,
  onRefresh
}: {
  automation: boolean
  settings: AppSettings
  snapshot: UsageSnapshot
  now: number
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const copy = COPY[settings.locale]
  const { isStale, statusLabel } = getUsageStatus(snapshot, settings, now)
  const modeLabel = settings.percentageMode === 'used' ? copy.used : copy.remaining
  const sourceLabel =
    snapshot.rateLimitSource === 'official'
      ? copy.officialSource
      : snapshot.rateLimitSource === 'cache'
        ? copy.cacheSource
        : copy.emptySource
  const fallbackBanner =
    snapshot.rateLimitSource === 'cache' && snapshot.officialIssue
      ? { title: copy.fallbackTitle, body: copy.fallbackBody }
      : snapshot.rateLimitSource === 'none' && snapshot.issues.length > 0
        ? { title: copy.unavailableTitle, body: copy.unavailableBody }
        : undefined

  return (
    <div className="panel__body panel__body--details">
      <div className="panel__content">
        <div className="panel__header panel__header--details">
          <div>
            <h2 className="panel__account" title={snapshot.account?.label}>
              {snapshot.account?.label ?? copy.unknownAccount}
            </h2>
            {snapshot.account ? (
              <p className="panel__workspace">
                {copy.workspace} {snapshot.account.workspace}
              </p>
            ) : null}
          </div>
          <span
            className={`sync-status ${isStale || snapshot.rateLimitSource === 'none' ? 'sync-status--warning' : ''}`}
            role="status"
          >
            {statusLabel}
          </span>
        </div>

        <div className="quota-heading">
          <h3>{copy.overview}</h3>
          <span>{modeLabel}</span>
        </div>
        {snapshot.rateLimits.length > 0 ? (
          <div
            className={`quota-grid${snapshot.rateLimits.length === 1 ? ' quota-grid--single' : ''} ${isStale ? 'quota-grid--stale' : ''}`}
          >
            {snapshot.rateLimits.map((windowState) => (
              <QuotaCard
                key={windowState.id}
                locale={settings.locale}
                modeLabel={modeLabel}
                percentageMode={settings.percentageMode}
                windowState={windowState}
                now={now}
              />
            ))}
          </div>
        ) : (
          <div className="quota-empty" role="status">
            <ClockIcon />
            <h3>
              {snapshot.isRefreshing
                ? copy.syncing
                : snapshot.rateLimitSource === 'official'
                  ? copy.noWindow
                  : copy.unavailableTitle}
            </h3>
            <p>
              {snapshot.rateLimitSource === 'official' ? copy.noWindowBody : copy.unavailableBody}
            </p>
          </div>
        )}

        {fallbackBanner && snapshot.rateLimits.length > 0 ? (
          <div className="fallback-card">
            <div className="fallback-card__icon">
              <AlertIcon />
            </div>
            <div className="fallback-card__content">
              <p className="fallback-card__title">{fallbackBanner.title}</p>
              <p className="fallback-card__body">{fallbackBanner.body}</p>
              {snapshot.officialIssue ? (
                <p className="fallback-card__body">{snapshot.officialIssue}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {automation ? <AutomationPanel view="credits" locale={settings.locale} now={now} /> : null}

        <details className="connection-details">
          <summary>
            {copy.diagnostics}
            <span>{sourceLabel}</span>
          </summary>
          <dl>
            <div>
              <dt>{copy.source}</dt>
              <dd>{snapshot.sourceHost}</dd>
            </div>
            <div>
              <dt>{copy.lastRefresh}</dt>
              <dd>{formatAbsoluteDate(snapshot.generatedAt, settings.locale)}</dd>
            </div>
            <div>
              <dt>{copy.path}</dt>
              <dd>{snapshot.authPath ?? '--'}</dd>
            </div>
          </dl>
          {snapshot.issues.map((issue) => (
            <p className="connection-details__issue" key={issue}>
              {issue}
            </p>
          ))}
        </details>
      </div>

      <div className="panel__footer">
        <div className="sync-caption">
          <span>{copy.lastSuccess}</span>
          <strong title={formatAbsoluteDate(snapshot.lastSuccessAt, settings.locale)}>
            {formatRelativeDate(snapshot.lastSuccessAt, settings.locale) ?? '--'}
          </strong>
        </div>
        <button
          className="ghost-button ghost-button--accent glass-surface"
          disabled={snapshot.canRefresh === false || snapshot.isRefreshing}
          onClick={() => {
            void onRefresh()
          }}
          type="button"
        >
          <GlassMaterial radius={10} />
          <HistoryIcon />
          <span>{snapshot.isRefreshing ? copy.syncing : copy.refresh}</span>
        </button>
      </div>
    </div>
  )
}

function QuotaCard({
  locale,
  modeLabel,
  percentageMode,
  windowState,
  now
}: {
  locale: LocaleCode
  modeLabel: string
  percentageMode: PercentageMode
  windowState: RateLimitWindowSnapshot
  now: number
}): React.JSX.Element {
  const displayPercent =
    percentageMode === 'used' ? windowState.usedPercent : windowState.remainingPercent
  const tone = resolveMetricTone(displayPercent, percentageMode)
  const progress =
    displayPercent === undefined || !Number.isFinite(displayPercent)
      ? 0
      : Math.min(100, Math.max(0, displayPercent))
  const seconds = windowState.resetsAt
    ? Math.max(0, (Date.parse(windowState.resetsAt) - now) / 1000)
    : undefined

  return (
    <div
      className={`quota-card glass-surface quota-card--${tone}`}
      style={{ '--metric-progress': `${progress}%` } as CSSProperties}
    >
      <GlassMaterial radius={16} />
      <div className="quota-card__head">
        <span className="quota-card__label">{formatWindowLabel(windowState, locale)}</span>
        <span className="quota-card__reading">
          <span className="quota-card__mode">{modeLabel}</span>
          <strong className="quota-card__value">
            {displayPercent === undefined ? '--' : `${Math.round(displayPercent)}%`}
          </strong>
        </span>
      </div>
      <span className="quota-card__progress" aria-hidden="true">
        <span />
      </span>
      <div className="quota-card__timing">
        <p className="quota-card__reset">{formatQuotaResetHint(seconds, locale)}</p>
        <p className="quota-card__date">{formatAbsoluteDate(windowState.resetsAt, locale)}</p>
      </div>
    </div>
  )
}

function formatQuotaResetHint(seconds: number | undefined, locale: LocaleCode): string {
  if (seconds === 0) return COPY[locale].pendingReset
  const duration = formatRelativeDuration(seconds, locale, locale === 'zh-CN')
  if (!duration) return '--'
  return locale === 'zh-CN' ? `${duration}重置` : `resets in ${duration}`
}

function formatWindowLabel(windowState: RateLimitWindowSnapshot, locale: LocaleCode): string {
  if (!windowState.windowMinutes) return windowState.label
  const minutes = windowState.windowMinutes
  return locale === 'en-US'
    ? windowState.label
    : minutes >= 1440
      ? `${minutes / 1440} 天`
      : minutes >= 60
        ? `${minutes / 60} 小时`
        : `${minutes} 分钟`
}
