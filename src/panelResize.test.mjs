// Geometry for the eight-way panel resize (src/panelResize.js). The pointer
// plumbing is DOM; this is the part that has to be right for a west/north
// drag not to slide the box across the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeRect, clampResizeRectToViewport, RESIZE_DIRECTIONS } from './panelResize.js';

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

// ── clampResizeRectToViewport ───────────────────────────────────────────
// The fix for "resize past the edge, let go, and the box snaps back": these
// run the SAME per-frame check the live pointermove handler applies, so a
// box growing off-screen is capped immediately instead of overshooting and
// correcting on release.

test('east handle: overflowing the right edge shrinks width, left stays put', () => {
  const grown = { left: 700, top: 200, width: 300, height: 400 }; // right edge at 1000
  const clamped = clampResizeRectToViewport(grown, 'e', 8, 900, 1000);
  assert.equal(clamped.left, 700, 'left edge is not this handle\'s to move');
  assert.equal(clamped.width, 900 - 8 - 700);
  assert.equal(clamped.top, 200);
  assert.equal(clamped.height, 400);
});

test('west handle: overflowing the left edge pins left to the inset and shrinks width, right edge stays put', () => {
  const rightEdge = 400; // left(100) + width(300) before this frame's overflow
  const grown = { left: -50, top: 200, width: 450, height: 400 };
  const clamped = clampResizeRectToViewport(grown, 'w', 8, 1200, 1000);
  assert.equal(clamped.left, 8);
  assert.equal(clamped.left + clamped.width, rightEdge, 'the un-dragged right edge does not drift');
});

test('south handle: overflowing the bottom edge shrinks height, top stays put', () => {
  const grown = { left: 100, top: 850, width: 300, height: 400 };
  const clamped = clampResizeRectToViewport(grown, 's', 8, 1200, 1000);
  assert.equal(clamped.top, 850);
  assert.equal(clamped.height, 1000 - 8 - 850);
});

test('north handle: overflowing the top edge pins top to the inset and shrinks height, bottom edge stays put', () => {
  const bottomEdge = 600; // top(200) + height(400) before this frame's overflow
  const grown = { left: 100, top: -30, width: 300, height: 630 };
  const clamped = clampResizeRectToViewport(grown, 'n', 8, 1200, 1000);
  assert.equal(clamped.top, 8);
  assert.equal(clamped.top + clamped.height, bottomEdge);
});

test('a rect fully inside the viewport is left untouched', () => {
  const rect = { left: 100, top: 200, width: 300, height: 400 };
  for (const dir of RESIZE_DIRECTIONS) {
    assert.deepEqual(clampResizeRectToViewport(rect, dir, 8, 1200, 1000), rect, dir);
  }
});

test('a corner handle only clamps the two edges it actually owns', () => {
  // 'se' only ever touches the right/bottom edges (see the resizeRect
  // ownership test above) — a left/top overflow it did not cause must not
  // be clamped away here either, or the box would visibly jump sideways.
  const rect = { left: -50, top: -50, width: 300, height: 400 };
  assert.deepEqual(clampResizeRectToViewport(rect, 'se', 8, 1200, 1000), rect);
});
