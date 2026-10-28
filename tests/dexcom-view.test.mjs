import test from 'node:test';
import assert from 'node:assert/strict';
import view from '../web/dexcom-view.js';

const reading = (minutes, glucoseMgDl = 120, extra = {}) => ({ clock: minutes * 60, timestamp: 1700000000000 + minutes * 60000, glucoseMgDl, state: 6, ...extra });

test('glucose plot spaces points by recorded time and leaves missing intervals open', () => {
  const data = view.series([reading(0), reading(5), reading(20), reading(25)]);
  assert.deepEqual(data.segments.map(segment => segment.length), [2, 2]);
  assert.ok(Math.abs((data.points[2].x - data.points[1].x) / (data.points[1].x - data.points[0].x) - 3) < 1e-9);
});

test('invalid, unavailable and stale readings break plot lines', () => {
  for (const extra of [{ glucoseMgDl: null }, { timestamp: null }, { glucoseMgDl: NaN }, { state: 1 }, { stale: true }, { displayOnly: true }, { ageSeconds: 601 }]) {
    const data = view.series([reading(0), reading(5, 120, extra), reading(10)]);
    assert.deepEqual(data.segments.map(segment => segment.length), [1, 1], JSON.stringify(extra));
  }
});

test('single points have finite coordinates and missing timestamps do not invent a time axis', () => {
  const data = view.series([reading(0)]);
  assert.ok(data.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.equal(view.series([reading(0, 120, { timestamp: null })]), null);
  assert.equal(view.series([reading(0, null)]), null);
});
