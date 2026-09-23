/**
 * Month boundaries in the account holder's own timezone (D9). Node already ships the tz
 * database with `Intl`, so this needs no dependency: a boundary is found by reading a wall
 * clock in that zone rather than by trusting the server's own offset, which on a hosted
 * runtime is always UTC and would put anyone east of Greenwich a day out at the edges.
 *
 * Nothing else in the codebase may work out a month for itself — components and services
 * both call in here.
 */

export const UTC_TIME_ZONE = 'UTC';

export interface MonthRange {
  /** 1–12, as counted in `timeZone`. */
  month: number;
  year: number;
  /** The timezone the boundaries were derived in, already checked and defaulted. */
  timeZone: string;
  /** First instant of the month. */
  start: Date;
  /** First instant of the *next* month: exclusive, so it pairs with `lt` and has no 1ms gap. */
  end: Date;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const MONTHS_IN_YEAR = 12;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws `RangeError` for a timezone the runtime does not know — `resolveTimeZone` catches it. */
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);

  if (cached !== undefined) {
    return cached;
  }

  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  formatters.set(timeZone, created);

  return created;
}

/** A profile timezone is free text in the database, so an unusable one falls back to UTC. */
export function resolveTimeZone(timeZone: string): string {
  try {
    partsFormatter(timeZone);

    return timeZone;
  } catch {
    return UTC_TIME_ZONE;
  }
}

/** What a clock in `timeZone` reads at `instant`. */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const values = new Map<string, string>();

  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    values.set(part.type, part.value);
  }

  const read = (type: keyof ZonedParts): number => Number(values.get(type));

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** How far ahead of UTC `timeZone` runs at `instant`, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    instant.getUTCMilliseconds(),
  );

  return asIfUtc - instant.getTime();
}

/**
 * The instant at which a month begins in `timeZone`. Read twice: the first offset comes from
 * the wrong instant — UTC midnight rather than local midnight — and if a daylight-saving
 * change falls between the two, the second reading is the one taken at the right time.
 */
function startOfMonth(year: number, month: number, timeZone: string): Date {
  const wallClock = Date.UTC(year, month - 1, 1);
  const firstOffset = offsetAt(new Date(wallClock), timeZone);
  const candidate = wallClock - firstOffset;
  const secondOffset = offsetAt(new Date(candidate), timeZone);

  return new Date(secondOffset === firstOffset ? candidate : wallClock - secondOffset);
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * MONTHS_IN_YEAR + (month - 1) + delta;

  return {
    year: Math.floor(zeroBased / MONTHS_IN_YEAR),
    month: (zeroBased % MONTHS_IN_YEAR) + 1,
  };
}

export function rangeFor(year: number, month: number, timeZone: string): MonthRange {
  const zone = resolveTimeZone(timeZone);
  const next = shiftMonth(year, month, 1);

  return {
    month,
    year,
    timeZone: zone,
    start: startOfMonth(year, month, zone),
    end: startOfMonth(next.year, next.month, zone),
  };
}

/** The calendar month `now` falls in, as the account holder sees it. */
export function monthRange(now: Date, timeZone: string): MonthRange {
  const zone = resolveTimeZone(timeZone);
  const { year, month } = zonedParts(now, zone);

  return rangeFor(year, month, zone);
}

/** The last `months` calendar months, oldest first, ending with the one `now` falls in. */
export function monthWindow(now: Date, timeZone: string, months: number): MonthRange[] {
  const zone = resolveTimeZone(timeZone);
  const current = zonedParts(now, zone);
  const window: MonthRange[] = [];

  for (let back = months - 1; back >= 0; back -= 1) {
    const { year, month } = shiftMonth(current.year, current.month, -back);

    window.push(rangeFor(year, month, zone));
  }

  return window;
}
