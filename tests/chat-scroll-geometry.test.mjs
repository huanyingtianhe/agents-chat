import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampScrollTop, correctedScrollTop, geometryChanged, isLayoutScroll, isNearBottom,
} from '../app/features/chat/chatScrollGeometry.ts';

test('restores a bottom-relative point instead of a scroll percentage', () => {
  assert.equal(correctedScrollTop(400, 1200, 700, 40, 2000), 940);
  assert.equal(correctedScrollTop(400, 500, 700, 40, 2000), 240);
  assert.equal(correctedScrollTop(400, 660, 700, 40, 2000), 400);
});

test('clamps both ends and short content', () => {
  assert.equal(clampScrollTop(-40, 2000), 0);
  assert.equal(clampScrollTop(2300, 2000), 2000);
  assert.equal(clampScrollTop(30, -20), 0);
  assert.equal(correctedScrollTop(0, 100, 700, 40, 2000), 0);
  assert.equal(correctedScrollTop(1900, 1200, 700, 40, 2000), 2000);
});

test('retains the existing four CSS pixel bottom tolerance', () => {
  assert.equal(isNearBottom(1596, 2400, 800), true);
  assert.equal(isNearBottom(1595.5, 2400, 800), false);
  assert.equal(isNearBottom(1500, 2400, 800), false);
  assert.equal(isNearBottom(1605, 2400, 800), true);
  assert.equal(isNearBottom(0, 200, 800), true);
});

test('detects wrapping, viewport and content geometry independently', () => {
  const before = { width: 390, height: 650, contentHeight: 6000 };
  assert.equal(geometryChanged(before, { ...before }), false);
  assert.equal(geometryChanged(before, { ...before, width: 844 }), true);
  assert.equal(geometryChanged(before, { ...before, height: 250 }), true);
  assert.equal(geometryChanged(before, { ...before, contentHeight: 6200 }), true);
});

test('only attributes preserved or clamped scroll offsets to layout', () => {
  assert.equal(isLayoutScroll(2400, 1200, 1200), true);
  assert.equal(isLayoutScroll(800, 800, 2400), true);
  assert.equal(isLayoutScroll(1250, 625, 1250), false);
  assert.equal(isLayoutScroll(1980, 2778, 6000), false);
  assert.equal(isLayoutScroll(100, 0, 0), true);
});
