// Activity / sleep state (module-scoped)
export const lastHumanActivity = new Map();  // channelId -> ts
const activityWindow = new Map();            // channelId -> [{ts, uid}, ...]
const speakerSet = new Map();                // channelId -> Set(userId)

/**
 * Record activity for momentum tracking.
 * options: { MOMENTUM_LOOKBACK_MIN }
 */
export function recordActivity(channelId, uid, ts, options) {
  const now = ts || Date.now();
  const cutoff = now - (options?.MOMENTUM_LOOKBACK_MIN ?? 20) * 60_000;

  const arr = activityWindow.get(channelId) || [];
  const pruned = arr.filter(e => e.ts >= cutoff);
  pruned.push({ ts: now, uid });
  activityWindow.set(channelId, pruned);

  const rebuilt = new Set(pruned.map(e => e.uid));
  speakerSet.set(channelId, rebuilt);
  return pruned;
}

export function windowStats(channelId) {
  const arr = activityWindow.get(channelId) || [];
  const speakers = speakerSet.get(channelId) || new Set();
  return { count: arr.length, speakers: speakers.size };
}

export function channelIsActive(channelId, options) {
  const { count, speakers } = windowStats(channelId);
  const needMsgs = count >= (options?.MOMENTUM_MIN_MSGS ?? 10);
  const needSpeakers = speakers >= (options?.MIN_DISTINCT_SPEAKERS ?? 3);
  return needMsgs && needSpeakers;
}

/**
 * Sleep after SLEEP_AFTER_MIN minutes of no human messages.
 * opts: { SLEEP_AFTER_MIN }
 */
export function isChannelSleeping(channelId, opts) {
  const last = lastHumanActivity.get(channelId) || 0;
  const ms = (opts?.SLEEP_AFTER_MIN ?? 60) * 60_000;
  return Date.now() - last >= ms;
}
