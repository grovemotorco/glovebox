import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { ComarkRenderer } from '@comark/react'
import { createParse } from 'comark'
import type { ComarkTree } from 'comark'
import security from 'comark/plugins/security'
import taskList from 'comark/plugins/task-list'
import toc from 'comark/plugins/toc'
import type { TocLink } from 'comark/plugins/toc'
import { useRoomContent, type RoomHandle } from '../state/workspace.tsx'

const parseMarkdown = createParse({
  autoClose: true,
  autoUnwrap: false,
  html: false,
  plugins: [
    security({ blockedTags: ['script', 'style', 'iframe', 'object', 'embed'] }),
    taskList(),
    toc({ depth: 3 }),
  ],
})

interface PreviewState {
  source: string
  tree: ComarkTree | null
  toc: TocLink[]
  error: string | null
}

const EMPTY_PREVIEW: PreviewState = {
  source: '',
  tree: null,
  toc: [],
  error: null,
}

export function Preview({
  handle,
  hasFile,
  showToc = false,
}: {
  handle: RoomHandle | null
  hasFile: boolean
  showToc?: boolean
}) {
  const content = useRoomContent(handle)
  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW)
  const parseIdRef = useRef(0)

  useEffect(() => {
    if (!hasFile) {
      setPreview(EMPTY_PREVIEW)
      return
    }

    const parseId = parseIdRef.current + 1
    parseIdRef.current = parseId

    void parseMarkdown(content)
      .then((tree) => {
        if (parseIdRef.current !== parseId) return
        setPreview({
          source: content,
          tree,
          toc: normalizeTocLinks(tree.meta.toc),
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (parseIdRef.current !== parseId) return
        setPreview({
          source: content,
          tree: null,
          toc: [],
          error: error instanceof Error ? error.message : 'Could not render preview',
        })
      })
  }, [content, hasFile])

  if (!hasFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--gb-text-muted)]">
        Select a file to preview
      </div>
    )
  }

  const isParsingCurrentContent = preview.source !== content

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_auto] overflow-hidden">
      <div className="min-h-0 overflow-y-auto px-8 py-10">
        <div className="mx-auto max-w-3xl">
          {preview.error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
              {preview.error}
            </div>
          ) : preview.tree ? (
            <ComarkRenderer
              tree={preview.tree}
              components={previewComponents}
              className="md-preview"
            />
          ) : (
            <div className="text-sm text-[var(--gb-text-muted)]">Rendering preview...</div>
          )}
          {isParsingCurrentContent && !preview.error && (
            <div className="mt-4 text-xs text-[var(--gb-text-muted)]">Updating preview...</div>
          )}
        </div>
      </div>
      {showToc && <TableOfContents links={preview.toc} />}
    </div>
  )
}

function TableOfContents({ links }: { links: TocLink[] }) {
  const flatLinks = useMemo(() => flattenTocLinks(links), [links])
  if (flatLinks.length === 0) return null

  return (
    <aside className="hidden w-56 border-l border-[var(--gb-border)] px-4 py-8 xl:block">
      <div className="sticky top-8">
        <div className="mb-3 font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--gb-text-muted)]">
          On this page
        </div>
        <nav aria-label="Table of contents" className="space-y-1">
          {flatLinks.map((link) => (
            <a
              key={`${link.id}-${link.depth}-${link.text}`}
              href={`#${link.id}`}
              className="block truncate rounded px-2 py-1 text-xs text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]"
              style={{ paddingLeft: `${(link.depth - 2) * 10 + 8}px` }}
            >
              {link.text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  )
}

function normalizeTocLinks(value: unknown): TocLink[] {
  if (!value || typeof value !== 'object') return []
  const links = (value as { links?: unknown }).links
  return Array.isArray(links) ? links.filter(isTocLink) : []
}

function isTocLink(value: unknown): value is TocLink {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TocLink).id === 'string' &&
    typeof (value as TocLink).text === 'string' &&
    typeof (value as TocLink).depth === 'number'
  )
}

function flattenTocLinks(links: TocLink[]): TocLink[] {
  return links.flatMap((link) => [link, ...flattenTocLinks(link.children ?? [])])
}

const previewComponents = {
  a: SafeAnchor,
}

function SafeAnchor({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) {
  if (!href || !isSafeUrl(href)) {
    return <span {...props}>{children}</span>
  }
  return (
    <a href={href} {...props}>
      {children}
    </a>
  )
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase()
  return (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('mailto:')
  )
}
