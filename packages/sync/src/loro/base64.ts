export function base64ToBytes(b64: string): Uint8Array {
  if (b64.length === 0) return new Uint8Array()
  if (typeof atob === 'function') {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  const buffer = getRuntimeBuffer()
  if (buffer) {
    return new Uint8Array(buffer.from(b64, 'base64'))
  }
  throw new Error('No base64 decoder is available in this runtime')
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return ''
  if (typeof btoa === 'function') {
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.byteLength; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  }
  const buffer = getRuntimeBuffer()
  if (buffer) {
    return buffer.from(bytes).toString('base64')
  }
  throw new Error('No base64 encoder is available in this runtime')
}

interface RuntimeBuffer {
  from(input: Uint8Array): { toString(encoding: 'base64'): string }
  from(input: string, encoding: 'base64'): Uint8Array
}

function getRuntimeBuffer(): RuntimeBuffer | undefined {
  return (globalThis as { Buffer?: RuntimeBuffer }).Buffer
}
