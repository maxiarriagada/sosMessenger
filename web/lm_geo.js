const EARTH_RADIUS_M = 6371000;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const SOS_COORDS_RE = /^SOS[\s·:]*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return NaN;
  }
  return Number(value);
}

function finiteCoordinates(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2].map(toNumber);
  return values.every(Number.isFinite) ? values : null;
}

export function normalizeHeading(value) {
  const degrees = toNumber(value);
  if (!Number.isFinite(degrees)) {
    return NaN;
  }
  return ((degrees % 360) + 360) % 360;
}

export function normalizeSigned(value) {
  const degrees = toNumber(value);
  if (!Number.isFinite(degrees)) {
    return NaN;
  }
  return ((degrees + 540) % 360) - 180;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const coordinates = finiteCoordinates(lat1, lon1, lat2, lon2);
  if (!coordinates) {
    return NaN;
  }
  const [aLat, aLon, bLat, bLon] = coordinates;
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(aLat)) *
      Math.cos(toRadians(bLat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const coordinates = finiteCoordinates(lat1, lon1, lat2, lon2);
  if (!coordinates) {
    return NaN;
  }
  const [aLat, aLon, bLat, bLon] = coordinates;
  const startLat = toRadians(aLat);
  const endLat = toRadians(bLat);
  const deltaLon = toRadians(bLon - aLon);
  const y = Math.sin(deltaLon) * Math.cos(endLat);
  const x =
    Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLon);
  return normalizeHeading(toDegrees(Math.atan2(y, x)));
}

export function relativeBearing(bearing, heading) {
  const bearingValue = normalizeHeading(bearing);
  const headingValue = normalizeHeading(heading);
  if (!Number.isFinite(bearingValue) || !Number.isFinite(headingValue)) {
    return NaN;
  }
  return normalizeSigned(bearingValue - headingValue);
}

export function cardinal(value) {
  const heading = normalizeHeading(value);
  if (!Number.isFinite(heading)) {
    return '—';
  }
  return CARDINALS[Math.round(heading / 45) % CARDINALS.length];
}

export function formatHeading(value) {
  const heading = normalizeHeading(value);
  if (!Number.isFinite(heading)) {
    return '—';
  }
  return `${Math.round(heading)}° ${cardinal(heading)}`;
}

export function formatMeters(value) {
  const meters = Number(value);
  if (!Number.isFinite(meters)) {
    return '';
  }
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${meters.toFixed(0)} m`;
}

export function formatDistance(lat1, lon1, lat2, lon2) {
  return formatMeters(distanceMeters(lat1, lon1, lat2, lon2));
}

export function parseSosText(value) {
  const text = String(value ?? '');
  const match = SOS_COORDS_RE.exec(text);
  if (!match) {
    return null;
  }
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return null;
  }
  const accuracyMatch = /±\s*(\d+(?:\.\d+)?)\s*m/i.exec(text);
  const altitudeMatch = /alt\s*(-?\d+(?:\.\d+)?)\s*m/i.exec(text);
  const clockMatch = /\b(\d{1,2}:\d{2}:\d{2})\b/.exec(text);
  return {
    lat,
    lon,
    accuracy: accuracyMatch ? Number(accuracyMatch[1]) : null,
    altitude: altitudeMatch ? Number(altitudeMatch[1]) : null,
    clock: clockMatch ? clockMatch[1] : null,
  };
}

export function routeInfo(origin, target, heading) {
  const distance = distanceMeters(origin?.lat, origin?.lon, target?.lat, target?.lon);
  const bearing = bearingDegrees(origin?.lat, origin?.lon, target?.lat, target?.lon);
  const relative = relativeBearing(bearing, heading);
  return {
    distance,
    bearing,
    relative,
    distanceText: formatMeters(distance),
    headingText: formatHeading(bearing),
    relativeText: formatRelative(relative),
  };
}

export function formatRelative(value) {
  const relative = normalizeSigned(value);
  if (!Number.isFinite(relative)) {
    return '—';
  }
  const absolute = Math.abs(relative);
  if (absolute < 5) {
    return 'al frente';
  }
  if (absolute > 175) {
    return 'atrás';
  }
  return `${Math.round(absolute)}° ${relative > 0 ? 'der.' : 'izq.'}`;
}
