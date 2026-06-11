import fs from 'node:fs';
import path from 'node:path';

const METRICS_REL_DIR = path.join('governance', 'metrics');
const METRIC_NAME = 'processed_inbox_items';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function monthOnly(date) {
  return date.toISOString().slice(0, 7);
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfIsoWeek(date) {
  const day = startOfUtcDay(date);
  const utcDay = day.getUTCDay();
  const daysFromMonday = (utcDay + 6) % 7;
  return addUtcDays(day, -daysFromMonday);
}

function endOfIsoWeek(date) {
  return addUtcDays(startOfIsoWeek(date), 6);
}

function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sortBy(key) {
  return (a, b) => String(a[key]).localeCompare(String(b[key]));
}

function trimRecords(records, limit) {
  return records.slice(Math.max(0, records.length - limit));
}

function normalizeProcessedPaths(processedPaths) {
  return [...new Set((processedPaths || [])
    .map((processedPath) => String(processedPath || '').trim())
    .filter(Boolean))];
}

function emptyDaily(updatedAt) {
  return {
    schema_version: 1,
    metric: METRIC_NAME,
    retention: {
      unit: 'day',
      limit: 100
    },
    updated_at: updatedAt,
    records: []
  };
}

function emptyWeekly(updatedAt) {
  return {
    schema_version: 1,
    metric: METRIC_NAME,
    retention: {
      unit: 'week',
      limit: 52
    },
    week_start_day: 'monday',
    updated_at: updatedAt,
    records: []
  };
}

function emptyMonthly(updatedAt) {
  return {
    schema_version: 1,
    metric: METRIC_NAME,
    retention: {
      unit: 'month',
      limit: 24
    },
    updated_at: updatedAt,
    records: []
  };
}

function emptySeenToday(now) {
  return {
    schema_version: 1,
    date: dateOnly(now),
    updated_at: now.toISOString(),
    seen: []
  };
}

export function getMetricsPaths(instanceRoot) {
  const metricsDir = path.join(instanceRoot, METRICS_REL_DIR);
  return {
    metricsDir,
    metricsRelDir: METRICS_REL_DIR,
    dailyPath: path.join(metricsDir, 'daily.json'),
    weeklyPath: path.join(metricsDir, 'weekly.json'),
    monthlyPath: path.join(metricsDir, 'monthly.json'),
    seenTodayPath: path.join(metricsDir, 'seen-today.json')
  };
}

export function createStarterMetricsFiles(instanceRoot, options = {}) {
  const now = options.now || new Date();
  const paths = getMetricsPaths(instanceRoot);
  ensureDir(paths.metricsDir);

  if (!fs.existsSync(paths.dailyPath)) writeJson(paths.dailyPath, emptyDaily(now.toISOString()));
  if (!fs.existsSync(paths.weeklyPath)) writeJson(paths.weeklyPath, emptyWeekly(now.toISOString()));
  if (!fs.existsSync(paths.monthlyPath)) writeJson(paths.monthlyPath, emptyMonthly(now.toISOString()));
  if (!fs.existsSync(paths.seenTodayPath)) writeJson(paths.seenTodayPath, emptySeenToday(now));

  return paths;
}

function upsertDaily(daily, today, increment, updatedAt) {
  const records = [...(daily.records || [])].sort(sortBy('date'));
  const existing = records.find((record) => record.date === today);

  if (existing) {
    existing.count = Number(existing.count || 0) + increment;
  } else {
    records.push({ date: today, count: increment });
  }

  return {
    ...daily,
    schema_version: 1,
    metric: METRIC_NAME,
    retention: { unit: 'day', limit: 100 },
    updated_at: updatedAt,
    records: trimRecords(records.sort(sortBy('date')), 100)
  };
}

function refreshCurrentWeek(weekly, daily, now, updatedAt) {
  const weekStart = startOfIsoWeek(now);
  const weekEnd = endOfIsoWeek(now);
  const weekStartText = dateOnly(weekStart);
  const weekEndText = dateOnly(weekEnd);
  const count = (daily.records || [])
    .filter((record) => record.date >= weekStartText && record.date <= weekEndText)
    .reduce((total, record) => total + Number(record.count || 0), 0);

  const records = (weekly.records || [])
    .filter((record) => record.week_start !== weekStartText);
  records.push({ week_start: weekStartText, week_end: weekEndText, count });

  return {
    ...weekly,
    schema_version: 1,
    metric: METRIC_NAME,
    retention: { unit: 'week', limit: 52 },
    week_start_day: 'monday',
    updated_at: updatedAt,
    records: trimRecords(records.sort(sortBy('week_start')), 52)
  };
}

function refreshCurrentMonth(monthly, daily, now, updatedAt) {
  const month = monthOnly(now);
  const monthStartText = dateOnly(startOfMonth(now));
  const monthEndText = dateOnly(endOfMonth(now));
  const count = (daily.records || [])
    .filter((record) => record.date >= monthStartText && record.date <= monthEndText)
    .reduce((total, record) => total + Number(record.count || 0), 0);

  const records = (monthly.records || [])
    .filter((record) => record.month !== month);
  records.push({ month, month_start: monthStartText, month_end: monthEndText, count });

  return {
    ...monthly,
    schema_version: 1,
    metric: METRIC_NAME,
    retention: { unit: 'month', limit: 24 },
    updated_at: updatedAt,
    records: trimRecords(records.sort(sortBy('month')), 24)
  };
}

export function recordProcessedInboxItems(instanceRoot, processedPaths, options = {}) {
  const now = options.now || new Date();
  const updatedAt = now.toISOString();
  const today = dateOnly(now);
  const paths = createStarterMetricsFiles(instanceRoot, { now });
  const normalizedPaths = normalizeProcessedPaths(processedPaths);

  let seenToday = readJsonIfExists(paths.seenTodayPath, emptySeenToday(now));
  if (seenToday.date !== today) {
    seenToday = emptySeenToday(now);
  }

  const seenKeys = new Set((seenToday.seen || []).map((entry) => entry.key));
  const newPaths = normalizedPaths.filter((processedPath) => !seenKeys.has(processedPath));
  const skipped = normalizedPaths.length - newPaths.length;

  for (const processedPath of newPaths) {
    seenToday.seen.push({
      key: processedPath,
      first_seen_at: updatedAt
    });
  }

  seenToday.updated_at = updatedAt;
  writeJson(paths.seenTodayPath, seenToday);

  let daily = readJsonIfExists(paths.dailyPath, emptyDaily(updatedAt));
  let weekly = readJsonIfExists(paths.weeklyPath, emptyWeekly(updatedAt));
  let monthly = readJsonIfExists(paths.monthlyPath, emptyMonthly(updatedAt));

  if (newPaths.length > 0) {
    daily = upsertDaily(daily, today, newPaths.length, updatedAt);
  } else {
    daily = {
      ...daily,
      schema_version: 1,
      metric: METRIC_NAME,
      retention: { unit: 'day', limit: 100 },
      updated_at: updatedAt,
      records: trimRecords([...(daily.records || [])].sort(sortBy('date')), 100)
    };
  }

  weekly = refreshCurrentWeek(weekly, daily, now, updatedAt);
  monthly = refreshCurrentMonth(monthly, daily, now, updatedAt);

  writeJson(paths.dailyPath, daily);
  writeJson(paths.weeklyPath, weekly);
  writeJson(paths.monthlyPath, monthly);

  return {
    ok: true,
    counted: newPaths.length,
    skipped,
    processed: normalizedPaths.length
  };
}
