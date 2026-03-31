import { describe, expect, it } from 'vitest';
import { normalizeChannelJid, validateSendRequest, type SendRequest } from '../src/send.js';

function request(files: string[]): SendRequest {
  return {
    channelJid: 'dc:123',
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
  it('requires at least one file', () => {
    expect(() => validateSendRequest(request([]), {
      maxAttachmentBytes: 1024,
      fileStat: () => ({ size: 1 }),
    })).toThrow('At least one file is required.');
  });

  it('rejects more than 10 files', () => {
    expect(() => validateSendRequest(request(Array.from({ length: 11 }, (_, i) => `file-${i}.txt`)), {
      maxAttachmentBytes: 1024,
      fileStat: () => ({ size: 1 }),
    })).toThrow('At most 10 files can be sent in a single message.');
  });

  it('throws when a file is missing', () => {
    expect(() => validateSendRequest(request(['missing.txt']), {
      maxAttachmentBytes: 1024,
      fileStat: () => {
        throw new Error('ENOENT');
      },
    })).toThrow('File not found: missing.txt');
  });

  it('rejects files that exceed the configured size limit', () => {
    expect(() => validateSendRequest(request(['large.bin']), {
      maxAttachmentBytes: 100,
      fileStat: () => ({ size: 101 }),
    })).toThrow('File exceeds max attachment size (100 bytes): large.bin');
  });
});
