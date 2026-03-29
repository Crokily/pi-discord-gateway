import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttachmentOnlyPrompt, selectAttachmentsWithinLimits, type AttachmentMeta } from './attachments.js';

function attachment(name: string, size: number): AttachmentMeta {
  return {
    url: `https://example.com/${name}`,
    name,
    contentType: 'application/octet-stream',
    size,
  };
}

test('selectAttachmentsWithinLimits enforces per-file and total limits', () => {
  const result = selectAttachmentsWithinLimits(
    [
      attachment('small.txt', 4),
      attachment('too-big.bin', 20),
      attachment('over-total.png', 7),
      attachment('fits-later.jpg', 6),
    ],
    { maxFileBytes: 10, maxTotalBytes: 10 },
  );

  assert.deepEqual(
    result.accepted.map((item) => item.name),
    ['small.txt', 'fits-later.jpg'],
  );
  assert.equal(result.totalAcceptedBytes, 10);
  assert.deepEqual(
    result.rejected.map(({ attachment: item, reason }) => [item.name, reason]),
    [
      ['too-big.bin', 'file-too-large'],
      ['over-total.png', 'total-too-large'],
    ],
  );
});

test('selectAttachmentsWithinLimits treats zero limits as disabled', () => {
  const result = selectAttachmentsWithinLimits(
    [
      attachment('first.bin', 30),
      attachment('second.bin', 40),
    ],
    { maxFileBytes: 0, maxTotalBytes: 0 },
  );

  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.totalAcceptedBytes, 70);
});

test('buildAttachmentOnlyPrompt handles singular and plural prompts', () => {
  assert.equal(buildAttachmentOnlyPrompt(1), '[Attachment-only message: 1 file attached.]');
  assert.equal(buildAttachmentOnlyPrompt(3), '[Attachment-only message: 3 files attached.]');
});
