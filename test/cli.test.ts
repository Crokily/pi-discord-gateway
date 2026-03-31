import { describe, expect, it } from 'vitest';
import { formatHelpText } from '../src/cli/index.js';

describe('formatHelpText', () => {
  it('mentions the primary distribution commands', () => {
    const help = formatHelpText();

    expect(help).toContain('piscord setup');
    expect(help).toContain('piscord start');
    expect(help).toContain('piscord status');
    expect(help).toContain('piscord register');
    expect(help).toContain('piscord daemon install');
  });
});
