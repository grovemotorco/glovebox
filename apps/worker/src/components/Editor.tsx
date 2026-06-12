import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { LoroSyncPlugin } from '@glovebox/loro-codemirror'
import type { RoomHandle } from '../state/workspace.tsx'

/**
 * CodeMirror bound straight to the room's Loro doc: the sync plugin commits
 * local edits into the CRDT (the room client auto-submits them over the
 * socket) and replays remote imports back into the editor.
 */
export function CodeEditor({ handle }: { handle: RoomHandle | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    if (!handle || handle.status !== 'ready') return

    // The room can be torn down (reconnect, workspace switch) between the
    // handle snapshot and this effect — skip the mount; a fresh handle
    // re-runs the effect once the room reopens.
    let doc: string
    let loroDoc: ReturnType<ReturnType<typeof handle.room.getDoc>['unwrap']>
    try {
      doc = handle.room.getTextContent()
      loroDoc = handle.room.getDoc().unwrap()
    } catch {
      return
    }

    const state = EditorState.create({
      doc,
      extensions: [
        basicSetup,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        oneDark,
        EditorView.lineWrapping,
        LoroSyncPlugin(loroDoc),
      ],
    })

    viewRef.current = new EditorView({
      state,
      parent: containerRef.current,
    })

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [handle])

  if (handle?.status === 'error') {
    return (
      <div className="flex items-center justify-center h-full text-sm text-red-400">
        {handle.error ?? 'Failed to open file'}
      </div>
    )
  }

  if (!handle || handle.status === 'connecting') {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--gb-text-muted)]">
        Opening…
      </div>
    )
  }

  return <div ref={containerRef} className="h-full overflow-hidden" />
}
