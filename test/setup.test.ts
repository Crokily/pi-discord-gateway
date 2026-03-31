import { describe, expect, it } from 'vitest';
import { buildConfigFile } from '../src/cli/setup.js';

describe('buildConfigFile', () => {
  it('includes the generated token and local path settings', () => {
    const text = buildConfigFile({
      token: 'discord-token',
      triggerName: 'PiBot',
      workingDir: '/workspace/project',
      sessionsDir: '/var/lib/pi-discord/sessions',
      dbPath: '/var/lib/pi-discord/gateway.db',
    });

    expect(text).toContain('DISCORD_BOT_TOKEN=discord-token');
    expect(text).toContain('TRIGGER_NAME=PiBot');
    expect(text).toContain('PI_CWD=/workspace/project');
    expect(text).toContain('SESSIONS_DIR=/var/lib/pi-discord/sessions');
    expect(text).toContain('DB_PATH=/var/lib/pi-discord/gateway.db');
  });
});
