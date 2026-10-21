import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const CLI_PATH = resolve(import.meta.dirname, '../dist/cli.js')

function runCli(args: string[] = []): string {
  try {
    return execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, NODE_ENV: 'test' },
    })
  } catch (err: any) {
    // Commander exits with code 0 for --help but execFileSync
    // may still capture stdout
    return err.stdout ?? err.stderr ?? ''
  }
}

describe('environment-manager CLI help', () => {
  it('shows help with available commands when run with no arguments', () => {
    const output = runCli()
    expect(output).toContain('Declarative environment variable sync, secret rotation, and verification')
    expect(output).toContain('sync')
    expect(output).toContain('rotate')
    expect(output).toContain('verify')
    expect(output).toContain('render')
  })

  it('shows help when --help flag is passed', () => {
    const output = runCli(['--help'])
    expect(output).toContain('Declarative environment variable sync, secret rotation, and verification')
    expect(output).toContain('Commands:')
  })

  it('shows usage examples in help output', () => {
    const output = runCli()
    expect(output).toContain('Examples:')
    expect(output).toContain('environment-manager render production')
  })

  it('does NOT show file1/file2 in usage', () => {
    const output = runCli()
    expect(output).not.toContain('file1')
    expect(output).not.toContain('file2')
  })
})
