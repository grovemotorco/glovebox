import { describe, expect, it } from 'vitest'
import {
  apiVersion,
  assertApiKey,
  base64StringSchema,
  commonErrors,
  contract,
  rpcUrl,
} from '../src/index.ts'

describe('@glovebox.md/api contract', () => {
  it('exports the v1 contract groups', () => {
    expect(apiVersion).toBe('v1')
    expect(Object.keys(contract)).toEqual([
      'health',
      'auth',
      'me',
      'workspaces',
      'members',
      'invites',
      'keys',
      'documents',
      'comments',
      'suggestions',
      'versions',
    ])
  })

  it('declares the shared structured error map required by v1', () => {
    expect(Object.keys(commonErrors)).toEqual([
      'VALIDATION',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'INVITE_NOT_FOUND',
      'KEY_NOT_FOUND',
      'STALE_VERSION',
      'WORKSPACE_DELETED',
      'TOO_MANY_REQUESTS',
      'NOT_IMPLEMENTED',
    ])
  })

  it('uses explicit base64 strings for public binary payloads', () => {
    expect(base64StringSchema.safeParse('YWJjZA==').success).toBe(true)
    expect(base64StringSchema.safeParse('not base64url-_').success).toBe(false)
  })

  it('provides typed client helper primitives', () => {
    expect(rpcUrl('https://api.glovebox.test/')).toBe('https://api.glovebox.test/api/rpc')
    expect(() => assertApiKey('gbx_test_key')).not.toThrow()
    expect(() => assertApiKey('bad_key')).toThrow('gbx_')
  })
})
