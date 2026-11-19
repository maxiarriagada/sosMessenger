import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDegrees,
  cardinal,
  distanceMeters,
  formatDistance,
  formatHeading,
  formatMeters,
  formatRelative,
  normalizeHeading,
  normalizeSigned,
  relativeBearing,
  routeInfo,
} from '../lm_geo.js';

const closeTo = (actual, expected, tolerance = 0.001) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test('normalizeHeading wraps degrees', () => {
  closeTo(normalizeHeading(0), 0);
  closeTo(normalizeHeading(360), 0);
  closeTo(normalizeHeading(-10), 350);
  closeTo(normalizeHeading(725), 5);
  assert.ok(Number.isNaN(normalizeHeading('x')));
});

test('normalizeSigned wraps to -180..180', () => {
  closeTo(normalizeSigned(190), -170);
  closeTo(normalizeSigned(-190), 170);
  closeTo(normalizeSigned(180), -180);
  assert.ok(Number.isNaN(normalizeSigned(null)));
});

test('distanceMeters uses great-circle distance', () => {
  closeTo(distanceMeters(0, 0, 0, 1), 111194.93, 1);
  closeTo(distanceMeters(-34.6, -58.4, -34.6, -58.4), 0, 0.001);
  assert.ok(Number.isNaN(distanceMeters(0, 0, 'x', 1)));
});

test('bearingDegrees returns initial bearing', () => {
  closeTo(bearingDegrees(0, 0, 1, 0), 0);
  closeTo(bearingDegrees(0, 0, 0, 1), 90);
  closeTo(bearingDegrees(0, 0, -1, 0), 180);
  closeTo(bearingDegrees(0, 0, 0, -1), 270);
  assert.ok(Number.isNaN(bearingDegrees(0, 0, 0, 'x')));
});

test('relativeBearing compares bearing with heading', () => {
  closeTo(relativeBearing(90, 0), 90);
  closeTo(relativeBearing(350, 10), -20);
  closeTo(relativeBearing(10, 350), 20);
  assert.ok(Number.isNaN(relativeBearing('x', 0)));
});

test('cardinal and formatHeading label directions', () => {
  assert.equal(cardinal(0), 'N');
  assert.equal(cardinal(45), 'NE');
  assert.equal(cardinal(90), 'E');
  assert.equal(cardinal(180), 'S');
  assert.equal(cardinal(270), 'O');
  assert.equal(cardinal(359), 'N');
  assert.equal(formatHeading(135), '135° SE');
  assert.equal(formatHeading(NaN), '—');
});

test('formatMeters and formatDistance format distances', () => {
  assert.equal(formatMeters(500), '500 m');
  assert.equal(formatMeters(1500), '1.50 km');
  assert.equal(formatMeters(NaN), '');
  assert.equal(formatDistance(0, 0, 0, 1), '111.19 km');
  assert.equal(formatDistance(0, 0, 'x', 1), '');
});

test('formatRelative describes left, right, front and behind', () => {
  assert.equal(formatRelative(2), 'al frente');
  assert.equal(formatRelative(-3), 'al frente');
  assert.equal(formatRelative(45), '45° der.');
  assert.equal(formatRelative(-45), '45° izq.');
  assert.equal(formatRelative(180), 'atrás');
  assert.equal(formatRelative(NaN), '—');
});

test('routeInfo combines distance, bearing and relative heading', () => {
  const route = routeInfo({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, 0);
  closeTo(route.distance, 111194.93, 1);
  closeTo(route.bearing, 90, 0.001);
  closeTo(route.relative, 90, 0.001);
  assert.equal(route.distanceText, '111.19 km');
  assert.equal(route.headingText, '90° E');
  assert.equal(route.relativeText, '90° der.');
});

test('routeInfo tolerates missing positions', () => {
  const route = routeInfo(null, null, null);
  assert.equal(route.distanceText, '');
  assert.equal(route.headingText, '—');
  assert.equal(route.relativeText, '—');
  assert.ok(Number.isNaN(route.bearing));
});
