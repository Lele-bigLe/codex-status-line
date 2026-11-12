import { useId } from 'react'
import Picker from '@rc-component/picker'
import dayjsGenerateConfig from '@rc-component/picker/generate/dayjs'
import enUS from '@rc-component/picker/locale/en_US'
import zhCN from '@rc-component/picker/locale/zh_CN'
import dayjs, { type Dayjs } from 'dayjs'
import 'dayjs/locale/zh-cn'
import type { LocaleCode } from '../../../shared/capsule'
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon } from './Icons'

export function SchedulePickerField({
  label,
  value,
  min,
  disabled,
  locale,
  picker = 'date',
  onChange
}: {
  label: string
  value: string
  min?: string
  disabled: boolean
  locale: LocaleCode
  picker?: 'date' | 'time'
  onChange: (value: string) => void
}): React.JSX.Element {
  const id = useId()
  const time = picker === 'time'
  const format = time ? 'HH:mm' : 'YYYY-MM-DD'
  const selected = dayjs(time ? `2000-01-01T${value}` : value)

  return (
    <div className="schedule-picker-field">
      <label htmlFor={id}>{label}</label>
      <Picker<Dayjs>
        id={id}
        className="schedule-picker"
        classNames={{ popup: { root: 'schedule-picker-popup' } }}
        generateConfig={dayjsGenerateConfig}
        locale={locale === 'en-US' ? enUS : zhCN}
        picker={picker}
        value={selected.isValid() ? selected : null}
        minDate={!time && min ? dayjs(min).startOf('day') : undefined}
        format={format}
        placeholder={format}
        disabled={disabled}
        allowClear={false}
        showSecond={false}
        showNow={false}
        needConfirm={time}
        previewValue={false}
        prevIcon={<ChevronLeftIcon />}
        nextIcon={<ChevronRightIcon />}
        superPrevIcon={
          <span className="schedule-picker-year-nav">
            <ChevronLeftIcon />
            <ChevronLeftIcon />
          </span>
        }
        superNextIcon={
          <span className="schedule-picker-year-nav">
            <ChevronRightIcon />
            <ChevronRightIcon />
          </span>
        }
        placement="bottomLeft"
        getPopupContainer={(node) => node.closest<HTMLElement>('.app-shell') ?? document.body}
        suffix={
          time ? (
            <ClockIcon />
          ) : (
            <svg fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M7 3v4m10-4v4M4 10h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          )
        }
        onChange={(date) => {
          if (date && !Array.isArray(date)) onChange(date.format(format))
        }}
      />
    </div>
  )
}
