import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { OnePasswordSecretStore } from './onepassword.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

const mockedExecFile = vi.mocked(execFile)

describe('OnePasswordSecretStore', () => {
  let store: OnePasswordSecretStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new OnePasswordSecretStore()
  })

  describe('canResolve', () => {
    it('returns true for op:// URIs', () => {
      expect(store.canResolve('op://Vault/Item/field')).toBe(true)
    })
    it('returns false for plain strings', () => {
      expect(store.canResolve('https://example.com')).toBe(false)
    })
    it('returns false for empty string', () => {
      expect(store.canResolve('')).toBe(false)
    })
  })

  describe('resolve', () => {
    it('shells out to op read and returns trimmed stdout', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(null, 'secret-value\n', '')
        return {} as any
      })
      const result = await store.resolve('op://Vault/Item/field')
      expect(result).toBe('secret-value')
      expect(mockedExecFile).toHaveBeenCalledWith(
        'op', ['read', 'op://Vault/Item/field'], expect.any(Function),
      )
    })
    it('throws when op CLI fails', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(new Error('op not found'), '', '')
        return {} as any
      })
      await expect(store.resolve('op://Vault/Item/field')).rejects.toThrow(
        'Failed to resolve 1Password reference op://Vault/Item/field: op not found',
      )
    })
  })

  describe('write', () => {
    it('shells out to op item edit', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(null, '', '')
        return {} as any
      })
      await store.write('item-123', 'my_field', 'new-value')
      expect(mockedExecFile).toHaveBeenCalledWith(
        'op', ['item', 'edit', 'item-123', 'my_field[concealed]=new-value'], expect.any(Function),
      )
    })

    it('reports op stderr on failure without repeating the new value', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        const err = Object.assign(
          new Error('Command failed: op item edit item-123 my_field[concealed]=new-value\n[ERROR] item not found'),
          { code: 1 },
        )
        cb(err, '', '[ERROR] item not found\n')
        return {} as any
      })
      const failure = await store.write('item-123', 'my_field', 'new-value').catch((e: Error) => e)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe(
        'Failed to write field my_field of 1Password item item-123: [ERROR] item not found',
      )
      expect((failure as Error).message).not.toContain('new-value')
    })

    it('falls back to the exit code when op prints nothing', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, cb: any) => {
        cb(Object.assign(new Error('Command failed: op item edit item-123 my_field[concealed]=new-value'), { code: 2 }), '', '')
        return {} as any
      })
      await expect(store.write('item-123', 'my_field', 'new-value')).rejects.toThrow(
        'Failed to write field my_field of 1Password item item-123: op exited with 2',
      )
    })
  })
})
