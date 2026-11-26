// Process-local failure counter per staff code. A fixed window (not a permanent lock) avoids letting an
// attacker deny an attendant indefinitely. Keys are bounded: expired windows are pruned and the oldest
// entry is dropped past maxKeys. This is a loopback-demo control, not distributed protection.
export function createSignInThrottle({ limit = 5, windowMs = 60_000, maxKeys = 1000 } = {}) {
  const failures = new Map();

  function prune(nowMs) {
    for (const [key, entry] of failures) {
      if (entry.windowEnds <= nowMs) failures.delete(key);
    }
  }

  return {
    isBlocked(key, nowMs) {
      prune(nowMs);
      return (failures.get(key)?.count ?? 0) >= limit;
    },
    recordFailure(key, nowMs) {
      const entry = failures.get(key);
      if (entry && entry.windowEnds > nowMs) {
        entry.count += 1;
        return;
      }
      failures.delete(key);
      failures.set(key, { count: 1, windowEnds: nowMs + windowMs });
      if (failures.size > maxKeys) failures.delete(failures.keys().next().value);
    },
    clear(key) {
      failures.delete(key);
    },
  };
}
