// Geometry for the eight-way panel resize (src/panelResize.js). The pointer
// plumbing is DOM; this is the part that has to be right for a west/north
// drag not to slide the box across the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeRect, RESIZE_DIRECTIONS } from './panelResize.js';

const START = { left: 100, top: 200, width: 300, height: 400 };
const LIMITS = { minWidth: 200, maxWidth: 500, minHeight: 250, maxHeight: 600 };

test('south-east grows away from a fixed top-left', () => {
  assert.deepEqual(resizeRect('se', START, 40, 30, LIMITS),
    { left: 100, top: 200, width: 340, height: 430 });
});

test('north-west grows toward the pointer, moving the top-left with it', () => {
  assert.deepEqual(resizeRect('nw', START, -40, -30, LIMITS),
    { left: 60, top: 170, width: 340, height: 430 });
});

test('an edge handle only touches its own axis', () => {
  assert.deepEqual(resizeRect('e', START, 40, 999, LIMITS),
    { left: 100, top: 200, width: 340, height: 400 });
  assert.deepEqual(resizeRect('n', START, 999, -30, LIMITS),
    { left: 100, top: 170, width: 300, height: 430 });
});

test('a west drag past the minimum width leaves the east edge where it was', () => {
  // Pointer has travelled 250px right; the box can only shrink by 100.
  const rect = resizeRect('w', START, 250, 0, LIMITS);
  assert.equal(rect.width, LIMITS.minWidth);
  assert.equal(rect.left + rect.width, START.left + START.width,
    'the far edge stays put once the box is pinned at its minimum');
});

test('a north drag past the maximum height leaves the south edge where it was', () => {
  const rect = resizeRect('n', START, 0, -500, LIMITS);
  assert.equal(rect.height, LIMITS.maxHeight);
  assert.equal(rect.top + rect.height, START.top + START.height);
});

test('every direction is honoured and none moves an edge it does not own', () => {
  for (const dir of RESIZE_DIRECTIONS) {
    const rect = resizeRect(dir, START, 20, 20, LIMITS);
    if (!dir.includes('w')) assert.equal(rect.left, START.left, `${dir} kept the left edge`);
    if (!dir.includes('n')) assert.equal(rect.top, START.top, `${dir} kept the top edge`);
    if (!dir.includes('e') && !dir.includes('w')) {
      assert.equal(rect.width, START.width, `${dir} kept the width`);
    }
    if (!dir.includes('n') && !dir.includes('s')) {
      assert.equal(rect.height, START.height, `${dir} kept the height`);
    }
  }
});
