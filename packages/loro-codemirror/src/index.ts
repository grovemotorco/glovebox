import { type Extension, Prec } from '@codemirror/state'
import { keymap, ViewPlugin } from '@codemirror/view'
import { LoroDoc, LoroText, UndoManager } from 'loro-crdt'
import { LoroSyncPluginValue } from './sync.ts'
import { undoKeyMap, undoManagerStateField, UndoPluginValue } from './undo.ts'
import { defaultGetTextFromDoc } from './utils.ts'

export { undo, redo } from './undo.ts'
export { defaultGetTextFromDoc as getTextFromDoc }

export const LoroSyncPlugin = (
  doc: LoroDoc,
  getTextFromDoc?: (doc: LoroDoc) => LoroText,
): Extension => {
  return ViewPlugin.define(
    (view) => new LoroSyncPluginValue(view, doc, getTextFromDoc ?? defaultGetTextFromDoc),
  )
}

export const LoroUndoPlugin = (
  doc: LoroDoc,
  undoManager: UndoManager,
  getTextFromDoc?: (doc: LoroDoc) => LoroText,
): Extension[] => {
  getTextFromDoc = getTextFromDoc ?? defaultGetTextFromDoc
  return [
    undoManagerStateField.init(() => undoManager),
    Prec.high(keymap.of([...undoKeyMap])),
    ViewPlugin.define((view) => new UndoPluginValue(view, doc, undoManager, getTextFromDoc)),
  ]
}

export function LoroExtensions(
  doc: LoroDoc,
  undoManager?: UndoManager,
  getTextFromDoc?: (doc: LoroDoc) => LoroText,
): Extension {
  getTextFromDoc = getTextFromDoc ?? defaultGetTextFromDoc

  const extension = [
    ViewPlugin.define((view) => new LoroSyncPluginValue(view, doc, getTextFromDoc)).extension,
  ]
  if (undoManager) {
    extension.push(
      undoManagerStateField.init(() => undoManager),
      Prec.high(keymap.of([...undoKeyMap])),
      ViewPlugin.define((view) => new UndoPluginValue(view, doc, undoManager, getTextFromDoc))
        .extension,
    )
  }

  return extension
}
