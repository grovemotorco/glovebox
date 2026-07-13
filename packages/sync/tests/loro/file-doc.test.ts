import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'

describe('LoroFileDoc', () => {
  it('round-trips text via snapshot', () => {
    const a = LoroFileDoc.empty('hello world')
    const snapshot = a.exportSnapshot()
    const b = LoroFileDoc.fromSnapshot(snapshot)
    expect(b.getTextContent()).toBe('hello world')
  })

  it('exports updates that can be replayed against a peer that shares the baseline', () => {
    const a = LoroFileDoc.empty()
    a.setTextContent('first')
    const baseSnapshot = a.exportSnapshot()
    const v0 = a.contentVersion()
    a.setTextContent('first second')
    const updateSinceV0 = a.exportUpdateSince(v0)

    const b = LoroFileDoc.fromSnapshot(baseSnapshot)
    expect(b.importUpdate(updateSinceV0)).toBe(true)
    expect(b.getTextContent()).toBe('first second')
  })

  it('exports a complete history when since=null', () => {
    const a = LoroFileDoc.empty('abc')
    a.setTextContent('abc def')
    const everything = a.exportUpdateSince(null)
    const b = LoroFileDoc.empty()
    b.importUpdate(everything)
    expect(b.getTextContent()).toBe('abc def')
  })

  it('reports no version advance when importing a known update twice', () => {
    const a = LoroFileDoc.empty()
    a.setTextContent('content')
    const update = a.exportUpdateSince(null)

    const b = LoroFileDoc.empty()
    expect(b.importUpdate(update)).toBe(true)
    expect(b.importUpdate(update)).toBe(false)
  })

  it('produces shallow snapshots that materialize equivalently', () => {
    const a = LoroFileDoc.empty()
    a.setTextContent('alpha')
    a.setTextContent('alpha beta')
    const shallow = a.exportShallowSnapshot()
    const b = LoroFileDoc.fromSnapshot(shallow)
    expect(b.getTextContent()).toBe('alpha beta')
  })

  it('materializes from a snapshot + queued updates', () => {
    const seed = LoroFileDoc.empty('initial')
    const snapshot = seed.exportSnapshot()
    const v0 = seed.contentVersion()
    seed.setTextContent('initial extended')
    const update1 = seed.exportUpdateSince(v0)

    const fromState = LoroFileDoc.fromState({ snapshot, updates: [update1] })
    expect(fromState.getTextContent()).toBe('initial extended')
  })

  it('materializes text at an exact historical content version', () => {
    const doc = LoroFileDoc.empty('base')
    const base = doc.contentVersion()
    doc.setTextContent('base plus')
    const extended = doc.contentVersion()

    expect(doc.getTextContentAtVersion(base)).toBe('base')
    expect(doc.getTextContentAtVersion(extended)).toBe('base plus')
    expect(doc.getTextContent()).toBe('base plus')
  })
})
