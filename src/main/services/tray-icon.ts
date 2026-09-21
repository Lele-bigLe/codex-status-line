import { selectPrimaryRateLimit, type AppSettings, type UsageSnapshot } from '../../shared/capsule'

const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000']
}

export function getTrayIconState(
  snapshot: UsageSnapshot,
  settings: AppSettings,
  now = Date.now()
): { text: string; color: string } {
  const primary = selectPrimaryRateLimit(snapshot.rateLimits)
  const percent = settings.percentageMode === 'used' ? primary?.usedPercent : primary?.remainingPercent
  const expired = Boolean(primary?.resetsAt && Date.parse(primary.resetsAt) <= now)
  if (
    percent === undefined ||
    !Number.isFinite(percent) ||
    expired ||
    snapshot.rateLimitSource === 'none'
  ) {
    return { text: '--', color: '#475569' }
  }
  const text = String(Math.round(Math.min(100, Math.max(0, percent))))
  const stale =
    snapshot.rateLimitSource === 'cache' ||
    Boolean(
      snapshot.lastSuccessAt &&
      now - Date.parse(snapshot.lastSuccessAt) >
        Math.max(90000, settings.refreshIntervalSeconds * 2000)
    )
  const remaining = settings.percentageMode === 'used' ? 100 - percent : percent
  return {
    text,
    color: stale ? '#475569' : remaining > 30 ? '#166534' : remaining > 10 ? '#92400e' : '#b91c1c'
  }
}

export function createTrayBitmap(text: string, color: string): Buffer {
  // Windows NativeImage 使用 BGRA；直接绘制像素字形，避免新增隐藏渲染窗口或图片依赖。
  const bitmap = Buffer.alloc(32 * 32 * 4)
  const rgb = Number.parseInt(color.slice(1), 16)
  for (let pixel = 0; pixel < 32 * 32; pixel++) {
    bitmap.set([rgb & 255, (rgb >> 8) & 255, (rgb >> 16) & 255, 255], pixel * 4)
  }
  const scaleX = text.length > 2 ? 2 : 4
  const left = (32 - (text.length * 4 - 1) * scaleX) / 2
  for (let digit = 0; digit < text.length; digit++) {
    const rows = DIGITS[text[digit]]
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 3 * scaleX; x++) {
        if (rows[Math.floor(y / 4)][Math.floor(x / scaleX)] !== '1') continue
        const offset = ((y + 6) * 32 + left + digit * 4 * scaleX + x) * 4
        bitmap.fill(255, offset, offset + 4)
      }
    }
  }
  return bitmap
}
