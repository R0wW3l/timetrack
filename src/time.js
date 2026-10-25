const { HttpError } = require('./httpError');

function pad(n) {
  return String(n).padStart(2, '0');
}

function normalizeUtc(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'Invalid timestamp');
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400, 'Invalid timestamp');
  return new Date(ms).toISOString();
}

function localParts(isoUtc, offsetMinutes) {
  const ms = Date.parse(isoUtc) + offsetMinutes * 60 * 1000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

function localDateString(isoUtc, offsetMinutes) {
  const p = localParts(isoUtc, offsetMinutes);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function formatTime(parts, timeFormat) {
  if (timeFormat === '12h') {
    const suffix = parts.hour >= 12 ? 'PM' : 'AM';
    let h = parts.hour % 12;
    if (h === 0) h = 12;
    return `${h}:${pad(parts.minute)}:${pad(parts.second)} ${suffix}`;
  }
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${pad(m)}:${pad(sec)}`;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeAmount(durationSeconds, hourlyWageCad) {
  return round2((durationSeconds / 3600) * hourlyWageCad);
}

function parseDateParam(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${label} must be YYYY-MM-DD`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new HttpError(400, `${label} must be a real calendar date`);
  }
  return value;
}

module.exports = {
  pad,
  normalizeUtc,
  localParts,
  localDateString,
  formatTime,
  formatDuration,
  round2,
  computeAmount,
  parseDateParam,
};
