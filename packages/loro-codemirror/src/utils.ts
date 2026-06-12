import type { LoroDoc, LoroText } from 'loro-crdt'

/**
 * Get the text from the document. Glovebox markdown files keep their text in
 * the root `content` container (TEXT_CONTAINER_ID in @glovebox/sync).
 */
export const defaultGetTextFromDoc = (doc: LoroDoc): LoroText => {
  return doc.getText('content')
}
