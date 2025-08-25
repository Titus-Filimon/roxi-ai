// src/index.js
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField,
} from 'discord.js';
import http from 'node:http';

/* =========================
   Env / Config
   ========================= */
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const MODE = process.env.ROXI_MODE || 'dev';        // dev|prod
let HARD_MUTE = process.env.ROXI_MUTE === '1';      // start muted?
const STATUS_PORT = Number(process.env.STATUS_PORT || 0); // 0 disables

// Sleep/wake config
const SLEEP_AFTER_MIN   = Number(process.env.ROXI_SLEEP_AFTER_MIN || 60); // 60 min of inactivity -> sleep
const WAKE_ANNOUNCE_SEC = Number(process.env.ROXI_WAKE_ANNOUNCE_SEC || 120); // announce if re-activated within this window
const WAKE_MSG_ENABLED  = (process.env.ROXI_WAKE_MSG_ENABLED ?? '0') === '1'; // 0 = silent wake

/* =========================
   Guardrails / Heuristics
   ========================= */
// Activity (momentum) window
const MOMENTUM_LOOKBACK_MIN   = Number(process.env.ROXI_MOMENTUM_MIN || 20);
const MOMENTUM_MIN_MSGS       = Number(process.env.ROXI_MOMENTUM_MSGS || 10);
const MIN_DISTINCT_SPEAKERS   = Number(process.env.ROXI_MIN_SPEAKERS || 3);

// Speak cadence & etiquette
const MIN_REPLY_GAP_MS   = Number(process.env.ROXI_CHANNEL_COOLDOWN_MS || 1000 * 60 * 3); // 3 min
const USER_GAP_MS        = Number(process.env.ROXI_USER_GAP_MS || 1000 * 20);             // wait ~20s after last human msg
const MAX_INPUT_CHARS    = Number(process.env.ROXI_MAX_INPUT_CHARS || 800);
const MAX_CONTEXT_MSGS   = Number(process.env.ROXI_MAX_CONTEXT_MSGS || 25);
const REPLY_PROBABILITY  = Number(process.env.ROXI_REPLY_PROBABILITY || 0.33);            // 33% when eligible
const THREADS_REQUIRE_ACTIVITY = (process.env.ROXI_THREADS_REQUIRE_ACTIVITY ?? '1') === '1';

// Avoid intruding on private-ish exchanges
const MIN_SPEAKERS_FOR_PUBLIC = Number(process.env.ROXI_MIN_SPEAKERS_PUBLIC || 3);
const MIN_SPEAKERS_FOR_THREAD = Number(process.env.ROXI_MIN_SPEAKERS_THREAD || 3);

// Optional: only allow in certain channels (leave empty to allow all)
const ALLOWED_CHANNELS = (process.env.ROXI_CHANNELS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Sensitive input filter
const BANNED_RE = /(password|api[_\- ]?key|token|ssn|secret|private key|seed phrase)/i;

/* =========================
   State
   ========================= */
const lastReplyPerChannel = new Map();     // channelId -> ts
const lastHumanActivity   = new Map();     // channelId -> ts of last human message
const activityWindow      = new Map();     // channelId -> [{ts, uid}, ...]
const speakerSet          = new Map();     // channelId -> Set(userId) in window

/* =========================
   Utils
   ========================= */
function log(lvl, obj = {}) {
  console.log(JSON.stringify({ lvl, ts: new Date().toISOString(), ...obj }));
}

function canSendInChannel(ch, clientUser) {
  const perms = ch?.permissionsFor?.(clientUser);
  return perms?.has(PermissionsBitField.Flags.SendMessages);
}

function sanitizeInput(text) {
  if (!text) return '';
  const t = text.slice(0, MAX_INPUT_CHARS);
  if (BANNED_RE.test(t)) return '';
  return t;
}

async function withTimeout(promise, ms = 9000) {
  let t;
  const timer = new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)));
  try { return await Promise.race([promise, timer]); }
  finally { clearTimeout(t); }
}

function rollProbability(p = REPLY_PROBABILITY) {
  return Math.random() < p;
}

/* =========================
   Sleep/Wake logic
   ========================= */
const SLEEP_AFTER_MS = SLEEP_AFTER_MIN * 60_000;

function isChannelSleeping(channelId) {
  const last = lastHumanActivity.get(channelId) || 0;
  return Date.now() - last >= SLEEP_AFTER_MS;
}

async function maybeAnnounceWake(channel) {
  if (!WAKE_MSG_ENABLED) return;
  const last = lastHumanActivity.get(channel.id) || 0;
  const slept = isChannelSleeping(channel.id);
  // If it *was* sleeping and activity just resumed (within a short window), say hi once
  if (!slept && Date.now() - last <= WAKE_ANNOUNCE_SEC * 1000) {
    try { await channel.send("☀️ I'm awake! What's going on?"); }
    catch {}
  }
}

/* =========================
   Momentum tracking
   ========================= */
function recordActivity(channelId, uid, ts) {
  const now = ts || Date.now();
  const cutoff = now - MOMENTUM_LOOKBACK_MIN * 60_000;

  // prune & push
  const arr = activityWindow.get(channelId) || [];
  const pruned = arr.filter(e => e.ts >= cutoff);
  pruned.push({ ts: now, uid });
  activityWindow.set(channelId, pruned);

  // rebuild speaker set from pruned window
  const rebuilt = new Set(pruned.map(e => e.uid));
  speakerSet.set(channelId, rebuilt);

  return pruned;
}

function windowStats(channelId) {
  const arr = activityWindow.get(channelId) || [];
  const speakers = speakerSet.get(channelId) || new Set();
  return { count: arr.length, speakers: speakers.size };
}

function channelIsActive(channel) {
  const { count, speakers } = windowStats(channel.id);
  const needMsgs = count >= MOMENTUM_MIN_MSGS;
  const needSpeakers = speakers >= MIN_DISTINCT_SPEAKERS;
  return needMsgs && needSpeakers;
}

/* =========================
   Speaking policy
   ========================= */
function allowedByChannelList(channel) {
  if (ALLOWED_CHANNELS.length === 0) return true;
  return ALLOWED_CHANNELS.includes(channel.name.toLowerCase());
}

function canEvenConsiderSpeaking(channel, lastUserTs) {
  if (HARD_MUTE) return false;
  if (!allowedByChannelList(channel)) return false;
  if (isChannelSleeping(channel.id)) return false; // sleep gate
  const now = Date.now();
  const last = lastReplyPerChannel.get(channel.id) || 0;
  return (now - last >= MIN_REPLY_GAP_MS) && (now - lastUserTs >= USER_GAP_MS);
}

function conversationEligible(channel) {
  const isThread = channel.isThread?.() ?? false;
  const { speakers } = windowStats(channel.id);

  // Avoid intruding on 1-to-1 vibes
  if (!isThread && speakers < MIN_SPEAKERS_FOR_PUBLIC) return false;
  if (isThread && THREADS_REQUIRE_ACTIVITY && speakers < MIN_SPEAKERS_FOR_THREAD) return false;

  // Require momentum regardless
  return channelIsActive(channel);
}

/* =========================
   Placeholder AI (swap later)
   ========================= */
async function generateReply(ctx) {
  // ctx: { channel, recent: { messages, speakers, count }, mode }
  const { speakers, count } = ctx.recent;
  const vibe = speakers >= 5 ? 'buzzing' : (speakers >= 3 ? 'active' : 'quiet');
  return `channel’s ${vibe} (${count} msgs / ${speakers} people) — what’s the plan?`;
}

/* =========================
   Discord client
   ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, () => {
  log('info', {
    msg: `Roxi online as ${client.user.tag}`,
    mode: MODE,
    sleepAfterMin: SLEEP_AFTER_MIN,
    momentum: { lookbackMin: MOMENTUM_LOOKBACK_MIN, minMsgs: MOMENTUM_MIN_MSGS, minSpeakers: MIN_DISTINCT_SPEAKERS },
    cadence: { channelCooldownMs: MIN_REPLY_GAP_MS, userGapMs: USER_GAP_MS, probability: REPLY_PROBABILITY },
  });
});

/* =========================
   Mute commands (admin only)
   ========================= */
async function handleAdminMute(msg) {
  const text = msg.content.trim().toLowerCase();
  const isAdmin = msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) return false;

  if (text === 'roxi mute') {
    HARD_MUTE = true;
    await msg.channel.send('🔇 Roxi muted by admin.');
    return true;
  }
  if (text === 'roxi unmute') {
    HARD_MUTE = false;
    await msg.channel.send('🔊 Roxi unmuted by admin.');
    return true;
  }
  return false;
}

/* =========================
   Main message handler
   ========================= */
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.inGuild()) return; // ignore DMs

    const channel = msg.channel;
    const channelName = channel?.name || '(unknown)';

    // Track human activity & momentum
    lastHumanActivity.set(channel.id, msg.createdTimestamp);
    recordActivity(channel.id, msg.author.id, msg.createdTimestamp);

    // Optional: wake announcement (only once right after a long sleep)
    if (!isChannelSleeping(channel.id)) {
      const elapsed = Date.now() - msg.createdTimestamp;
      if (elapsed <= WAKE_ANNOUNCE_SEC * 1000) {
        await maybeAnnounceWake(channel);
      }
    }

    // Admin kill switch
    if (await handleAdminMute(msg)) return;

    // Global gates
    const lastUserTs = lastHumanActivity.get(channel.id) || msg.createdTimestamp;
    if (!canEvenConsiderSpeaking(channel, lastUserTs)) return;
    if (!conversationEligible(channel)) return;
    if (!canSendInChannel(channel, client.user)) {
      log('warn', { evt: 'no_send_perm', channel: channelName });
      return;
    }

    // Build recent context (last N messages)
    const history = await channel.messages.fetch({ limit: Math.min(50, MAX_CONTEXT_MSGS) }).catch(() => null);
    const sorted = history
      ? [...history.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      : [];
    const trimmed = sorted.slice(-MAX_CONTEXT_MSGS).map(m => ({
      author: m.author.bot ? 'bot' : (m.member?.displayName || m.author.username),
      content: sanitizeInput(m.cleanContent || ''),
      ts: m.createdTimestamp,
      isBot: m.author.bot,
    })).filter(m => m.content || !m.isBot);

    if (trimmed.length === 0) return;

    // Final randomness so it doesn't feel robotic
    if (!rollProbability()) return;

    // Generate (wire your LLM/RAG here)
    const reply = await withTimeout(generateReply({
      channel: `#${channelName}`,
      recent: {
        messages: trimmed,
        speakers: (speakerSet.get(channel.id) || new Set()).size,
        count: (activityWindow.get(channel.id) || []).length,
      },
      mode: MODE,
    }), 9000);

    if (reply && reply.trim()) {
      await channel.send(reply.trim());
      lastReplyPerChannel.set(channel.id, Date.now());
      log('info', { evt: 'send', channel: channelName, bytes: reply.length, recentMsgs: trimmed.length });
    }
  } catch (err) {
    log('error', { evt: 'handler_error', err: err?.message || String(err) });
  }
});

/* =========================
   Health endpoint (optional)
   ========================= */
if (STATUS_PORT > 0) {
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      const body = JSON.stringify({
        ok: true,
        bot: client.user?.tag || null,
        mode: MODE,
        sleepAfterMin: SLEEP_AFTER_MIN,
        momentum: { lookbackMin: MOMENTUM_LOOKBACK_MIN, minMsgs: MOMENTUM_MIN_MSGS, minSpeakers: MIN_DISTINCT_SPEAKERS },
        uptimeSec: Math.floor(process.uptime()),
        ts: new Date().toISOString(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(STATUS_PORT, () => log('info', { evt: 'status_listen', port: STATUS_PORT }));
}

/* =========================
   Boot
   ========================= */
client.login(TOKEN).catch((e) => {
  console.error('❌ Login failed:', e?.message || e);
  process.exit(1);
});