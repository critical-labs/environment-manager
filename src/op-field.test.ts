import { describe, it, expect } from 'vitest'
import { resolveOpField } from './op-field.js'

describe('resolveOpField', () => {
  it('appends _preview for preview when field is a bare base name', () => {
    expect(resolveOpField('session_secret', 'preview')).toBe('session_secret_preview')
  })

  it('does not double the suffix when the field already ends in _preview', () => {
    expect(resolveOpField('app_client_secret_preview', 'preview')).toBe(
      'app_client_secret_preview',
    )
  })

  it('uses the base field unchanged for production', () => {
    expect(resolveOpField('session_secret', 'production')).toBe('session_secret')
  })

  it('leaves a production-suffixed field unchanged for production', () => {
    expect(resolveOpField('admin_app_client_secret_production', 'production')).toBe(
      'admin_app_client_secret_production',
    )
  })
})
