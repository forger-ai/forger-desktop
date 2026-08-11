export const HISTORY_INITIAL_LIMIT = 5;
export const HISTORY_LIMIT_STEP = 10;

export const isMacOsPlatform = (): boolean =>
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

export const historyUpdatedAtTimestamp = (updatedAt: string): number => {
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export const sortItemsByRecentActivity = <T extends { updatedAt: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => historyUpdatedAtTimestamp(right.updatedAt) - historyUpdatedAtTimestamp(left.updatedAt));

export const formatRelativeHistoryTime = (updatedAt: string, nowLabel: string): string => {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const diffSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return nowLabel;
  }

  const units: Array<[string, number]> = [
    ['y', 60 * 60 * 24 * 365],
    ['mo', 60 * 60 * 24 * 30],
    ['w', 60 * 60 * 24 * 7],
    ['d', 60 * 60 * 24],
    ['h', 60 * 60],
    ['m', 60],
  ];
  // The earlier guard guarantees at least the final minute bucket matches.
  const [unit, seconds] = units.find(([, unitSeconds]) => diffSeconds >= unitSeconds)!;
  return `${Math.floor(diffSeconds / seconds)}${unit}`;
};
