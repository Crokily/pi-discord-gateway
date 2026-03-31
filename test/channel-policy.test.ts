import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalCwd = process.cwd()
const originalEnv = { ...process.env }
const tempDirs: string[] = []
const CONFIG_ENV_KEYS = ['CHANNEL_POLICY', 'EXCLUDED_CHANNELS', 'HOME', 'PIDG_CONFIG']

afterEach(() => {
  vi.resetModules()
  process.chdir(originalCwd)

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('channel policy config', () => {
  it('defaults channelPolicy to allowlist when env var is unset', async () => {
    const { homeDir, workDir } = createIsolatedDirs()
    process.chdir(workDir)
    process.env.HOME = homeDir
    delete process.env.PIDG_CONFIG
    delete process.env.CHANNEL_POLICY
    delete process.env.EXCLUDED_CHANNELS

    const { config } = await loadConfigModule()

    expect(config.channelPolicy).toBe('allowlist')
  })

  it('parses EXCLUDED_CHANNELS into a Set', async () => {
    const { homeDir, workDir } = createIsolatedDirs()
    process.chdir(workDir)
    process.env.HOME = homeDir
    delete process.env.PIDG_CONFIG
    delete process.env.CHANNEL_POLICY
    process.env.EXCLUDED_CHANNELS = '123, 456, 789'

    const { config } = await loadConfigModule()

    expect(config.excludedChannels.has('123')).toBe(true)
    expect(config.excludedChannels.has('456')).toBe(true)
    expect(config.excludedChannels.has('789')).toBe(true)
    expect(config.excludedChannels.has('999')).toBe(false)
    expect(config.excludedChannels.size).toBe(3)
  })
})

describe('buildConfigFile channel policy settings', () => {
  it('includes channel policy and excluded channels placeholders', async () => {
    const { buildConfigFile } = await import('../src/setup.js')
    const text = buildConfigFile({
      token: 'discord-token',
      triggerName: 'PiBot',
      workingDir: '/workspace/project',
      channelPolicy: 'open-trigger',
      sessionsDir: '/var/lib/pi-discord/sessions',
      dbPath: '/var/lib/pi-discord/gateway.db',
    })

    expect(text).toContain('CHANNEL_POLICY=open-trigger')
    expect(text).toContain('EXCLUDED_CHANNELS=')
  })
})

function createIsolatedDirs(): { homeDir: string; workDir: string } {
  const homeDir = mkdtempSync(join(tmpdir(), 'pidg-channel-policy-home-'))
  const workDir = mkdtempSync(join(tmpdir(), 'pidg-channel-policy-work-'))
  tempDirs.push(homeDir, workDir)
  return { homeDir, workDir }
}

async function loadConfigModule() {
  vi.resetModules()
  return import('../src/config.js')
}
