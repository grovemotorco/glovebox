// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { LoroDoc } from 'loro-crdt'
import { LoroSyncPlugin, getTextFromDoc } from '../src/index.ts'

function makeEditor(doc: LoroDoc) {
  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [LoroSyncPlugin(doc)],
    }),
    parent: document.body,
  })
  return view
}

async function flushInit(): Promise<void> {
  // The plugin hydrates the editor in a microtask after construction.
  await Promise.resolve()
  await Promise.resolve()
}

describe('LoroSyncPlugin', () => {
  it("binds to the 'content' root container by default", async () => {
    const doc = new LoroDoc()
    doc.getText('content').update('# hello\n')
    doc.commit()

    const view = makeEditor(doc)
    await flushInit()
    expect(view.state.doc.toString()).toBe('# hello\n')

    view.dispatch({ changes: { from: 8, to: 8, insert: 'typed' } })
    expect(doc.getText('content').toString()).toBe('# hello\ntyped')
    expect(getTextFromDoc(doc).toString()).toBe('# hello\ntyped')
    view.destroy()
  })

  it('applies a text event that follows another container event in the same batch', async () => {
    const docA = new LoroDoc()
    docA.setPeerId(1n)
    docA.getText('content').update('base')
    docA.commit()

    const view = makeEditor(docA)
    await flushInit()
    expect(view.state.doc.toString()).toBe('base')

    // Remote peer mutates a map container AND the text in one update —
    // the import batch interleaves a non-text event before the text one.
    const docB = new LoroDoc()
    docB.setPeerId(2n)
    docB.import(docA.export({ mode: 'snapshot' }))
    const base = docB.oplogVersion()
    docB.getMap('meta').set('title', 'changed')
    docB.getText('content').update('base + remote')
    docB.commit()

    docA.import(docB.export({ mode: 'update', from: base }))

    expect(view.state.doc.toString()).toBe('base + remote')
    view.destroy()
  })

  it('applies multiple sequential remote text events without double-application', async () => {
    const docA = new LoroDoc()
    docA.setPeerId(1n)
    docA.getText('content').update('start')
    docA.commit()

    const view = makeEditor(docA)
    await flushInit()

    const docB = new LoroDoc()
    docB.setPeerId(2n)
    docB.import(docA.export({ mode: 'snapshot' }))

    // Two separate remote commits land as one import with several events.
    const base = docB.oplogVersion()
    docB.getText('content').update('start one')
    docB.commit()
    docB.getText('content').update('start one two')
    docB.commit()
    docA.import(docB.export({ mode: 'update', from: base }))

    expect(view.state.doc.toString()).toBe('start one two')
    expect(docA.getText('content').toString()).toBe('start one two')
    view.destroy()
  })
})
