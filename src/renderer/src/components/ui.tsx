/** Shared UI primitives: buttons, inputs, sliders, switches, modals, menus. */
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ChevronRight, Search, X } from 'lucide-react'

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  block?: boolean
  loading?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  block,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={clsx(
        'btn',
        variant !== 'default' && `btn--${variant}`,
        size === 'sm' && 'btn--sm',
        size === 'lg' && 'btn--lg',
        block && 'btn--block',
        !children && 'btn--icon',
        className
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  active,
  ...rest
}: ButtonProps & { label: string; active?: boolean }) {
  return (
    <button className="btn btn--ghost btn--icon tip" data-tip={label} aria-label={label} aria-pressed={active} {...rest}>
      {children}
    </button>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  autoFocus
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
}) {
  return (
    <div className="search-field">
      <Search size={13} />
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {value && (
        <button
          className="btn btn--ghost btn--icon btn--sm"
          style={{ position: 'absolute', right: 2 }}
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  action
}: {
  label: string
  hint?: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="field">
      <div className="label">
        <span>{label}</span>
        {action}
      </div>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  format?: (value: number) => string
}) {
  const percent = ((value - min) / (max - min)) * 100
  return (
    <div className="row" style={{ gap: 8 }}>
      <input
        type="range"
        className="slider"
        style={{ ['--percent' as string]: `${Math.max(0, Math.min(100, percent))}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{format ? format(value) : value}</span>
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { id: T; label: string; title?: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-pressed={value === option.id}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Badge({
  children,
  tone = 'default',
  title
}: {
  children: ReactNode
  tone?: 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info'
  title?: string
}) {
  return (
    <span className={clsx('badge', tone !== 'default' && `badge--${tone}`)} title={title}>
      {children}
    </span>
  )
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
  dismissable = true
}: {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'wide' | 'full'
  dismissable?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, dismissable])

  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div className={clsx('modal', size !== 'md' && `modal--${size}`)} role="dialog" aria-modal>
        <div className="modal__header">
          <div>
            <div className="modal__title">{title}</div>
            {subtitle && <div className="hint" style={{ marginTop: 4 }}>{subtitle}</div>}
          </div>
          {dismissable && (
            <IconButton label="Close" onClick={onClose}>
              <X size={15} />
            </IconButton>
          )}
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  )
}

export interface MenuItem {
  label?: string
  icon?: ReactNode
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 8),
      y: Math.min(y, window.innerHeight - rect.height - 8)
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((item, i) =>
        item.separator ? (
          <div className="context-menu__sep" key={`sep-${i}`} />
        ) : (
          <button
            key={item.label ?? i}
            className="context-menu__item"
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.()
              onClose()
            }}
            role="menuitem"
            style={item.danger ? { color: 'var(--danger)' } : undefined}
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
            {item.shortcut && <span className="kbd">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action
}: {
  icon: ReactNode
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <div className="empty-state__title">{title}</div>
      {body && <div className="empty-state__body">{body}</div>}
      {action}
    </div>
  )
}

export function ProgressBar({ percent, indeterminate }: { percent: number; indeterminate?: boolean }) {
  return (
    <div className={clsx('progress', indeterminate && 'progress--indeterminate')} role="progressbar" aria-valuenow={percent}>
      <div className="progress__fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  compact
}: {
  value: T
  options: { id: T; label: string; icon?: ReactNode; count?: number }[]
  onChange: (value: T) => void
  compact?: boolean
}) {
  return (
    <div className="tabs" role="tablist" style={compact ? { border: 'none', background: 'transparent', padding: 0 } : undefined}>
      {options.map((option) => (
        <button
          key={option.id}
          className="tab"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.icon}
          {option.label}
          {option.count !== undefined && <span className="badge">{option.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Disclosure row used across the inspector. */
export function Accordion({
  title,
  children,
  defaultOpen = true,
  right
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  right?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderBottom: '1px solid var(--separator)' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          height: 32,
          padding: '0 12px',
          color: open ? 'var(--text)' : 'var(--text-secondary)'
        }}
      >
        <ChevronRight
          size={13}
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
        />
        <span className="label" style={{ flex: 1, textAlign: 'left' }}>
          {title}
        </span>
        {right}
      </button>
      {open && <div style={{ padding: '4px 12px 12px' }}>{children}</div>}
    </div>
  )
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="tip" data-tip={label}>
      {children}
    </span>
  )
}
