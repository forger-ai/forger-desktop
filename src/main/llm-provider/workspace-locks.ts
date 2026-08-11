const locks = new Map<string, Promise<void>>();

const normalizeLockKey = (key: string): string => key.trim() || 'default';

export const withWorkspaceLock = async <T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> => {
  const normalized = normalizeLockKey(key);
  const previous = locks.get(normalized) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(normalized, queued);

  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(normalized) === queued) {
      locks.delete(normalized);
    }
  }
};
export const acquireWorkspaceLock = async (key: string): Promise<() => void> => {
  const normalized = normalizeLockKey(key);
  const previous = locks.get(normalized) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(normalized, queued);
  await previous;

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    release();
    if (locks.get(normalized) === queued) {
      locks.delete(normalized);
    }
  };
};
