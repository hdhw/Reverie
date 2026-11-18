import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePath, saveImage, setLoadingScreens, setBoard } from '../lib/content.mjs';

test('image paths cannot leave the Images folder', () => {
  assert.equal(imagePath('../../../data/config.json'), null);
  assert.equal(imagePath('../Program.cs'), null);
  assert.equal(imagePath('RROs/not-a-real-image.jpg'), null);
});

test('uploads must be real PNG or JPEG data', () => {
  assert.throws(() => saveImage('evil.png', Buffer.from('<script>').toString('base64')), /PNG or JPEG/);
  assert.throws(() => saveImage('empty.png', ''), /PNG or JPEG/);
});

test('loading screens only accept known images and need a title', () => {
  assert.throws(() => setLoadingScreens([]), /between 1 and 30/);
  assert.throws(() => setLoadingScreens([{ ImageName: '../../x.png', Title: 'x' }]), /doesn't exist/);
});

test('board links must be http(s)', () => {
  assert.throws(() => setBoard({ message: 'hi', moreInfoUrl: 'javascript:alert(1)' }), /http/);
});
