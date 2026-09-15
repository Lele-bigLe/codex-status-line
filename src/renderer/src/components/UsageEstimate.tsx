import { useState } from 'react'
import type { AppSettings, UsageSnapshot } from '../../../shared/capsule'
import { MODEL_PRICES, type ModelPrice, type WindowEstimate } from '../../../shared/estimation'

export function UsageEstimate({
  snapshot,
  settings,
  now
}: {
  snapshot: UsageSnapshot
  settings: AppSettings
  now: number
}): React.JSX.Element {
  const en = settings.locale === 'en-US'
  const data = snapshot.estimation
  const [reference, setReference] = useState('gpt-6-astra')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const prices = { ...MODEL_PRICES, ...settings.estimationPrices }
  const price = prices[reference]
  const number = (value: number): string =>
    new Intl.NumberFormat(settings.locale, { maximumFractionDigits: 1 }).format(value)
  const money = (value?: number): string => (value === undefined ? '--' : `≈ $${value.toFixed(2)}`)
  const reason = (value: WindowEstimate['reason']): string => {
    switch (value) {
      case 'scope':
        return en
          ? 'Confirm account scope to estimate total quota.'
          : '确认账号使用范围后，开始校准总额度。'
      case 'unpriced':
        return en
          ? 'Unpriced or missing usage in this sample; add prices and restart calibration.'
          : '样本含未知价格或缺失用量，请补充价格后重新校准。'
      case 'stale':
        return en ? 'Waiting for fresh official quota.' : '等待最新官方额度，暂停预测。'
      case 'reset':
        return en ? 'Waiting for a confirmed reset time.' : '等待官方确认额度周期。'
      default:
        return en
          ? 'Collecting: at least 10 minutes, 3 observations and 5 percentage points are needed.'
          : '采样中：至少需要 10 分钟、3 次观测及 5 个百分点的消耗。'
    }
  }

  async function confirmScope(confirmed: boolean): Promise<void> {
    setBusy(true)
    setError(false)
    try {
      await window.codexStatus.confirmEstimationScope(confirmed)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="usage-estimate" aria-label={en ? 'Usage estimates' : '用量估算'}>
      <div className="quota-heading">
        <h3>{en ? 'Usage estimates' : '用量估算'}</h3>
        <span>{snapshot.plan ?? (en ? 'Plan unknown' : '套餐未知')}</span>
      </div>
      <p className="usage-estimate__note">
        {en
          ? 'API-equivalent value, not your subscription balance or bill. Each quota window is estimated independently; do not add them together.'
          : 'API 等价费用，不是订阅余额或账单。每个额度窗口独立估算，总量不能相加。'}
      </p>
      <label className="usage-estimate__scope">
        <input
          type="checkbox"
          checked={data?.scopeConfirmed ?? false}
          disabled={busy || snapshot.rateLimitSource !== 'official' || snapshot.isRefreshing}
          onChange={(event) => {
            void confirmScope(event.target.checked)
          }}
        />
        <span>
          {en
            ? 'Only this account and this device are in use. Use new local usage to calibrate quota.'
            : '当前仅此账号、此设备使用，允许以新增本机用量校准额度。'}
        </span>
      </label>
      <p className="usage-estimate__note">
        {en
          ? 'Confirm again after restarting or switching accounts. Changing plan or prices restarts calibration. Other devices, cloud tasks and missing logs can underestimate capacity.'
          : '重启或切换账号后需重新确认；套餐、价格变化会重新校准。其他设备、云端任务或日志缺失可能低估总额度。'}
      </p>
      {error ? (
        <p role="alert">
          {en ? 'Could not update calibration. Refresh and retry.' : '校准设置失败，请刷新后重试。'}
        </p>
      ) : null}
      {data?.logIssue ? (
        <p role="status">
          {en
            ? 'Local logs are unavailable or incomplete; calibration paused.'
            : '本机日志不可用或不完整，已暂停校准。'}
        </p>
      ) : null}
      <label className="usage-estimate__reference">
        <span>{en ? 'Token conversion model' : 'Token 折算模型'}</span>
        <select value={reference} onChange={(event) => setReference(event.target.value)}>
          {Object.keys(prices).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <p className="usage-estimate__note">
        {en
          ? 'Token equivalents use the selected model’s uncached input price, not a promise of actual usable tokens.'
          : 'Token 数按所选模型的未缓存输入单价折算，不代表实际可用 Token 保证。'}
      </p>
      {data?.windows.map((sample) => {
        const expired =
          Date.parse(
            snapshot.rateLimits.find((window) => window.id === sample.id)?.resetsAt ?? ''
          ) <= now
        const stale =
          snapshot.rateLimitSource !== 'official' ||
          now - Date.parse(snapshot.lastSuccessAt ?? '') > 120000
        const estimate: WindowEstimate =
          expired || stale
            ? {
                id: sample.id,
                label: sample.label,
                samples: sample.samples,
                consumedPercent: sample.consumedPercent,
                confidence: 'insufficient',
                reason: expired ? 'reset' : 'stale'
              }
            : sample
        return (
          <article className="usage-estimate__window" key={estimate.id}>
            <div className="quota-heading">
              <h3>{estimate.label}</h3>
              <span>
                {en ? 'Confidence: ' : '可信度：'}
                {estimate.confidence === 'medium'
                  ? en
                    ? 'medium'
                    : '中'
                  : estimate.confidence === 'low'
                    ? en
                      ? 'low'
                      : '低'
                    : en
                      ? 'insufficient'
                      : '样本不足'}
              </span>
            </div>
            <dl>
              <div>
                <dt>{en ? 'Estimated total' : '预估总额度'}</dt>
                <dd>{money(estimate.totalCost)}</dd>
              </div>
              <div>
                <dt>{en ? 'Estimated remaining' : '预估剩余额度'}</dt>
                <dd>{money(estimate.remainingCost)}</dd>
              </div>
              <div>
                <dt>{en ? 'Total token equivalent' : '总量 Token 折算'}</dt>
                <dd>
                  {estimate.totalCost !== undefined && price
                    ? `≈ ${number(estimate.totalCost / price.input)} M`
                    : '--'}
                </dd>
              </div>
              <div>
                <dt>{en ? 'Remaining token equivalent' : '剩余 Token 折算'}</dt>
                <dd>
                  {estimate.remainingCost !== undefined && price
                    ? `≈ ${number(estimate.remainingCost / price.input)} M`
                    : '--'}
                </dd>
              </div>
              <div>
                <dt>{en ? 'Recent usage rate' : '近期消耗速度'}</dt>
                <dd>
                  {estimate.percentPerHour === undefined
                    ? '--'
                    : `${number(estimate.percentPerHour)}% / h`}
                </dd>
              </div>
              <div>
                <dt>{en ? 'Time at recent pace' : '按近期速度还能用'}</dt>
                <dd>
                  {estimate.hoursRemaining === undefined
                    ? '--'
                    : `≈ ${number(estimate.hoursRemaining)} h`}
                </dd>
              </div>
            </dl>
            {estimate.reason ? (
              <p className="usage-estimate__note">{reason(estimate.reason)}</p>
            ) : (
              <p className="usage-estimate__note">
                {en ? 'Total rounding range' : '总量取整误差范围'}：{money(estimate.totalLow)} –{' '}
                {money(estimate.totalHigh)}。
                {en ? 'Not a statistical confidence interval.' : '非统计置信区间。'}
              </p>
            )}
            <p className="usage-estimate__note">
              {en ? 'Observed quota consumption' : '采样消耗'}：{number(estimate.consumedPercent)}%
              · {estimate.samples} {en ? 'observations' : '次观测'}
            </p>
            {estimate.runsOutBeforeReset !== undefined ? (
              <p
                className={
                  estimate.runsOutBeforeReset ? 'usage-estimate__warning' : 'usage-estimate__note'
                }
              >
                {estimate.runsOutBeforeReset
                  ? en
                    ? 'At this pace, quota may run out before reset.'
                    : '按近期速度，额度可能在重置前耗尽。'
                  : en
                    ? 'At this pace, quota may last until reset.'
                    : '按近期速度，额度预计可维持到重置。'}
              </p>
            ) : null}
          </article>
        )
      })}
      {!data?.windows.length ? (
        <p className="usage-estimate__note">
          {en ? 'Waiting for quota observations.' : '等待额度观测数据。'}
        </p>
      ) : null}
      <details>
        <summary>{en ? 'Local model usage & pricing' : '本机模型用量与价格'}</summary>
        <p className="usage-estimate__note">
          {en
            ? 'New usage since monitoring started; no historical backfill. Input includes cached tokens; output includes reasoning. M = million tokens.'
            : '仅统计监测启动后的新增用量，不回填历史。输入包含缓存，输出包含推理。M = 百万 Token。'}
        </p>
        {data ? (
          <p className="usage-estimate__note">
            {new Date(data.startedAt).toLocaleString(settings.locale)}
          </p>
        ) : null}
        {data?.models.map((usage) => (
          <div className="usage-estimate__model" key={usage.model}>
            <strong>{usage.model}</strong>
            <span>{money(usage.cost)}</span>
            <p>
              {en ? 'Input / cache read / cache write / output' : '输入 / 缓存读 / 缓存写 / 输出'}：
              {[usage.input, usage.cached, usage.write, usage.output]
                .map((value) => number(value / 1e6))
                .join(' / ')}{' '}
              M
            </p>
            {usage.cost === undefined ? (
              <p>{en ? 'Price unknown. Token counts only.' : '价格未知，仅统计 Token。'}</p>
            ) : null}
          </div>
        ))}
        {!data?.models.length ? (
          <p className="usage-estimate__note">
            {en ? 'No new local usage yet.' : '暂无新增本机用量。'}
          </p>
        ) : null}
        <p className="usage-estimate__note">
          {en
            ? 'Reference: standard short-context API prices, checked 2026-09-15. No Fast, long-context, regional or tool surcharges; comparisons use this fixed baseline.'
            : '折算基准：2026-09-15 核对的标准短上下文 API 单价。未加 Fast、长上下文、区域及工具费用，统一按此基准比较。'}{' '}
          <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noreferrer">
            {en ? 'Official prices' : '官方价格'}
          </a>
        </p>
        <PriceEditor settings={settings} models={data?.models.map((model) => model.model) ?? []} />
      </details>
    </section>
  )
}

function PriceEditor({
  settings,
  models
}: {
  settings: AppSettings
  models: string[]
}): React.JSX.Element {
  const en = settings.locale === 'en-US'
  const [model, setModel] = useState('')
  const [rates, setRates] = useState({ input: '', cached: '', write: '', output: '' })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const fields = {
    input: en ? 'Input' : '输入',
    cached: en ? 'Cached input' : '缓存读',
    write: en ? 'Cache write' : '缓存写',
    output: en ? 'Output' : '输出'
  }
  return (
    <form
      className="usage-estimate__prices"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setMessage('')
        try {
          const price = Object.fromEntries(
            Object.entries(rates).map(([key, value]) => [key, Number(value)])
          ) as unknown as ModelPrice
          const saved = await window.codexStatus.updateSettings({
            estimationPrices: { ...settings.estimationPrices, [model]: price }
          })
          if (JSON.stringify(saved.settings.estimationPrices[model]) !== JSON.stringify(price)) {
            throw new Error('Price was not accepted')
          }
          setMessage(
            en
              ? 'Saved. Confirm scope to start a new calibration.'
              : '已保存，请重新确认范围开始校准。'
          )
        } catch {
          setMessage(en ? 'Save failed.' : '保存失败。')
        } finally {
          setBusy(false)
        }
      }}
    >
      <label>
        {en
          ? 'Add / override model price (USD per 1M tokens)'
          : '补充／覆盖模型单价（美元／百万 Token）'}
        <input
          value={model}
          required
          maxLength={100}
          pattern="[a-zA-Z0-9][a-zA-Z0-9._\/\-]*"
          list="estimate-models"
          onChange={(event) => {
            const name = event.target.value
            setModel(name)
            const price = Object.hasOwn(settings.estimationPrices, name)
              ? settings.estimationPrices[name]
              : Object.hasOwn(MODEL_PRICES, name)
                ? MODEL_PRICES[name]
                : undefined
            if (price)
              setRates({
                input: String(price.input),
                cached: String(price.cached),
                write: String(price.write),
                output: String(price.output)
              })
            else setRates({ input: '', cached: '', write: '', output: '' })
          }}
        />
      </label>
      <datalist id="estimate-models">
        {[
          ...new Set([
            ...Object.keys(MODEL_PRICES),
            ...Object.keys(settings.estimationPrices),
            ...models
          ])
        ].map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div>
        {(Object.keys(fields) as (keyof ModelPrice)[]).map((key) => (
          <label key={key}>
            {fields[key]}
            <input
              type="number"
              required
              min={key === 'input' ? '0.000001' : '0'}
              max="1000000"
              step="any"
              value={rates[key]}
              onChange={(event) => setRates({ ...rates, [key]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <button type="submit" disabled={busy}>
        {en ? 'Save price & restart calibration' : '保存价格并重新校准'}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  )
}
