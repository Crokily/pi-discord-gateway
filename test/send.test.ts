import { describe, expect, it, vi } from 'vitest';
import { normalizeChannelJid, validateSendRequest, type SendRequest } from '../src/discord/send.js';

function request(files: string[], text?: string): SendRequest {
  return {
    channelJid: 'dc:123',
    text,
    files,
  };
}

describe('normalizeChannelJid', () => {
  it('adds the dc: prefix when needed', () => {
    expect(normalizeChannelJid('123')).toBe('dc:123');
  });

  it('keeps an existing dc: prefix', () => {
    expect(normalizeChannelJid('dc:123')).toBe('dc:123');
  });
});

describe('validateSendRequest', () => {
  it('allows text-only messages without files', () => {
    const fileStat = vi.fn();

    expect(() =>
      validateSendRequest(request([], 'hello'), {
        maxAttachmentBytes: 1024,
        fileStat,
      }),
    ).not.toThrow();

    expect(fileStat).not.toHaveBeenCalled();
  });

  it('requires text or at least one file', () => {
    expect(() =>
      validateSendRequest(request([]), {
        maxAttachmentBytes: 1024,
        fileStat: () => ({ size: 1 }),
      }),
    ).toThrow('Either text or at least one file is required.');
  });

  it('rejects more than 10 files', () => {
    expect(() =>
      validateSendRequest(request(Array.from({ length: 11 }, (_, i) => `file-${i}.txt`)), {
        maxAttachmentBytes: 1024,
        fileStat: () => ({ size: 1 }),
      }),
    ).toThrow('At most 10 files can be sent in a single message.');
  });

  it('throws when a file is missing', () => {
    expect(() =>
      validateSendRequest(request(['missing.txt']), {
        maxAttachmentBytes: 1024,
        fileStat: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow('File not found: missing.txt');
  });

  it('rejects files that exceed the configured size limit', () => {
    expect(() =>
      validateSendRequest(request(['large.bin']), {
        maxAttachmentBytes: 100,
        fileStat: () => ({ size: 101 }),
      }),
    ).toThrow('File exceeds max attachment size (100 bytes): large.bin');
  });
});
