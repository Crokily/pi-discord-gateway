import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  resolveChannelMediaMessageDir,
  resolveChannelSessionDir,
  validateSessionFolder,
} from './session-path.js';

test('validateSessionFolder allows nested relative folders', () => {
  assert.equal(validateSessionFolder('guild/general'), 'guild/general');
});

test('validateSessionFolder rejects traversal', () => {
  assert.throws(() => validateSessionFolder('../escape'));
  assert.throws(() => validateSessionFolder('guild/../escape'));
});

test('resolveChannelMediaMessageDir stays under the validated session directory', () => {
  const sessionDir = resolveChannelSessionDir('guild/general');
  const mediaDir = resolveChannelMediaMessageDir('guild/general', 'msg123');

  assert.equal(mediaDir, resolve(sessionDir, 'media', 'msg-msg123'));
});

test('resolveChannelMediaMessageDir rejects unsafe message ids', () => {
  assert.throws(() => resolveChannelMediaMessageDir('guild/general', '../bad'));
  assert.throws(() => resolveChannelMediaMessageDir('guild/general', 'nested/path'));
});
