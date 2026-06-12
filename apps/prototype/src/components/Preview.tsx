import { useMemo } from 'react'
import { useAppState } from '../data/store.ts'

export function Preview() {
  const { activeFileId, fileContents } = useAppState()
  const content = activeFileId ? (fileContents.get(activeFileId) ?? '') : ''

  const html = useMemo(() => renderMarkdown(content), [content])

  if (!activeFileId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--gb-text-muted)] text-sm">
        Select a file to preview
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="md-preview max-w-3xl mx-auto" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

function renderMarkdown(src: string): string {
  let html = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const lines = html.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeBuffer: string[] = []
  let inList = false
  let listType: 'ul' | 'ol' = 'ul'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        result.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)
        codeBuffer = []
        inCodeBlock = false
      } else {
        if (inList) {
          result.push(`</${listType}>`)
          inList = false
        }
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeBuffer.push(line)
      continue
    }

    const checkboxMatch = line.match(/^- \[([ x])\] (.*)$/)
    if (checkboxMatch) {
      if (!inList) {
        result.push('<ul>')
        inList = true
        listType = 'ul'
      }
      const checked = checkboxMatch[1] === 'x' ? 'checked disabled' : 'disabled'
      result.push(
        `<li style="list-style:none;margin-left:-1.5rem"><input type="checkbox" ${checked} style="margin-right:0.5rem;accent-color:var(--gb-accent)">${inlineFormat(checkboxMatch[2])}</li>`,
      )
      continue
    }

    const ulMatch = line.match(/^- (.*)$/)
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) result.push(`</${listType}>`)
        result.push('<ul>')
        inList = true
        listType = 'ul'
      }
      result.push(`<li>${inlineFormat(ulMatch[1])}</li>`)
      continue
    }

    const olMatch = line.match(/^\d+\. (.*)$/)
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) result.push(`</${listType}>`)
        result.push('<ol>')
        inList = true
        listType = 'ol'
      }
      result.push(`<li>${inlineFormat(olMatch[1])}</li>`)
      continue
    }

    if (inList && line.trim() === '') {
      result.push(`</${listType}>`)
      inList = false
    }

    if (line.startsWith('### ')) {
      if (inList) {
        result.push(`</${listType}>`)
        inList = false
      }
      result.push(`<h3>${inlineFormat(line.slice(4))}</h3>`)
    } else if (line.startsWith('## ')) {
      if (inList) {
        result.push(`</${listType}>`)
        inList = false
      }
      result.push(`<h2>${inlineFormat(line.slice(3))}</h2>`)
    } else if (line.startsWith('# ')) {
      if (inList) {
        result.push(`</${listType}>`)
        inList = false
      }
      result.push(`<h1>${inlineFormat(line.slice(2))}</h1>`)
    } else if (line.startsWith('&gt; ')) {
      if (inList) {
        result.push(`</${listType}>`)
        inList = false
      }
      result.push(`<blockquote><p>${inlineFormat(line.slice(5))}</p></blockquote>`)
    } else if (line.startsWith('---')) {
      if (inList) {
        result.push(`</${listType}>`)
        inList = false
      }
      result.push('<hr/>')
    } else if (line.match(/^\|.*\|$/)) {
      if (inList) {
        result.push(`</${listType}>`)
        inList = false
      }
      const isHeader = lines[i + 1]?.match(/^\|[-| :]+\|$/)
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim())
      if (isHeader) {
        result.push(
          `<table><thead><tr>${cells.map((c) => `<th>${inlineFormat(c)}</th>`).join('')}</tr></thead><tbody>`,
        )
        i++
        if (!lines[i + 1]?.match(/^\|.*\|$/)) {
          result.push('</tbody></table>')
        }
      } else {
        result.push(`<tr>${cells.map((c) => `<td>${inlineFormat(c)}</td>`).join('')}</tr>`)
        if (!lines[i + 1]?.match(/^\|.*\|$/)) {
          result.push('</tbody></table>')
        }
      }
    } else if (line.trim() === '') {
      // skip blank lines
    } else {
      if (inList) {
        result.push(`</${listType}>`)
        inList = false
      }
      result.push(`<p>${inlineFormat(line)}</p>`)
    }
  }

  if (inList) result.push(`</${listType}>`)
  if (inCodeBlock) result.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)

  return result.join('\n')
}

function isSafeUrl(url: string): boolean {
  const decoded = url
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
  const trimmed = decoded.trim().toLowerCase()
  return (
    /^https?:\/\//.test(trimmed) ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/')
  )
}

function inlineFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, (_, label, url) =>
      isSafeUrl(url) ? `<a href="${url}">${label}</a>` : `<a>${label}</a>`,
    )
}
