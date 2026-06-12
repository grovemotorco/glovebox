import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { CheckIcon, ChevronDownIcon } from './icons.tsx'

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel: string
  /** Stretch the trigger to fill its container (for full-width form fields). */
  fullWidth?: boolean
  size?: 'sm' | 'md'
}

interface MenuCoords {
  left: number
  top: number
  width: number
}

/**
 * Accessible listbox dropdown that replaces the native `<select>` so menus
 * match the app's dark theme. Focus stays on the trigger; the open list is
 * announced via `aria-activedescendant` and supports full keyboard navigation
 * (arrows, Home/End, Enter/Space, Escape).
 *
 * The menu is positioned with `position: fixed` so it escapes `overflow`
 * clipping from scroll containers (e.g. the settings dialog) and flips above
 * the trigger when there isn't room below.
 */
export function Select({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  fullWidth,
  size = 'md',
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [coords, setCoords] = useState<MenuCoords | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const baseId = useId()

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const optionId = (index: number) => `${baseId}-option-${index}`

  useEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // Position the fixed menu under (or above) the trigger and keep it pinned
  // while the surrounding container scrolls or the window resizes.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const menuHeight = menuRef.current?.offsetHeight ?? 0
      const margin = 4
      const spaceBelow = window.innerHeight - rect.bottom
      const flipUp = menuHeight > 0 && spaceBelow < menuHeight + margin && rect.top > spaceBelow
      setCoords({
        left: rect.left,
        width: rect.width,
        top: flipUp ? Math.max(8, rect.top - menuHeight - margin) : rect.bottom + margin,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Keep the highlighted option in view while navigating with the keyboard.
  useEffect(() => {
    if (!open) return
    document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, baseId])

  function openMenu() {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function commit(index: number) {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openMenu()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((index) => Math.min(index + 1, options.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((index) => Math.max(index - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(options.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        break
    }
  }

  const triggerSize = size === 'sm' ? 'px-2 py-1.5 text-xs gap-1.5' : 'px-3 py-1.5 text-sm gap-2'
  const optionSize = size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'

  return (
    <div className={`relative ${fullWidth ? 'w-full' : 'inline-block'}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        className={`flex items-center justify-between rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] text-[var(--gb-text)] transition-colors hover:border-[color-mix(in_srgb,var(--gb-text-muted)_45%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 ${triggerSize} ${fullWidth ? 'w-full' : ''}`}
      >
        <span className="truncate">{selected?.label ?? 'Select…'}</span>
        <ChevronDownIcon
          size={size === 'sm' ? 14 : 16}
          className="flex-shrink-0 text-[var(--gb-text-muted)] transition-transform duration-150"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: 'fixed',
            left: coords?.left,
            top: coords?.top,
            minWidth: coords?.width,
            visibility: coords ? 'visible' : 'hidden',
          }}
          className="z-50 max-h-60 overflow-y-auto rounded-lg border border-[var(--gb-border)] bg-[var(--gb-surface)] py-1 shadow-2xl"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
              <button
                type="button"
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={`flex w-full items-center gap-2 text-left whitespace-nowrap transition-colors ${optionSize} ${
                  index === activeIndex ? 'bg-[var(--gb-hover)]' : ''
                } ${isSelected ? 'text-[var(--gb-text)]' : 'text-[var(--gb-text-muted)]'}`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isSelected && (
                  <CheckIcon size={14} className="flex-shrink-0 text-[var(--gb-accent)]" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
