import { describe, expect, it } from 'vitest';
import { selectAttachmentsWithinLimits, type AttachmentMeta } from '../src/discord/attachments.js';

function attachment(name: string, size: number): AttachmentMeta {
  return {
    url: `https://example.com/${name}`,
    name,
    contentType: 'text/plain',
    size,
  };
}

describe('selectAttachmentsWithinLimits', () => {
  it('rejects files that exceed the per-file size limit', () => {
    const result = selectAttachmentsWithinLimits(
      [
        attachment('small.txt', 128),
        attachment('large.txt', 512),
        attachment('medium.txt', 256),
      ],
      { maxFileBytes: 300, maxTotalBytes: 10_000 },
    );

    expect(result.accepted.map((item) => item.name)).toEqual(['small.txt', 'medium.txt']);
    expect(result.rejected).toEqual([
      {
        attachment: attachment('large.txt', 512),
        reason: 'file-too-large',
        limitBytes: 300,
      },
    ]);
    expect(result.totalAcceptedBytes).toBe(384);
  });

  it('rejects files that would exceed the total attachment limit while keeping valid later files', () => {
    const result = selectAttachmentsWithinLimits(
      [
        attachment('first.txt', 100),
        attachment('second.txt', 120),
        attachment('third.txt', 80),
      ],
      { maxFileBytes: 500, maxTotalBytes: 200 },
    );

    expect(result.accepted.map((item) => item.name)).toEqual(['first.txt', 'third.txt']);
    expect(result.rejected).toEqual([
      {
        attachment: attachment('second.txt', 120),
        reason: 'total-too-large',
        limitBytes: 200,
      },
    ]);
    expect(result.totalAcceptedBytes).toBe(180);
  });
});
