import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';
import http from 'node:http';

import { handleTextCommand } from './commands.js';
import { generateReply } from './ai.js';
import {
  recordActivity,
  windowStats,
  channelIsActive,
  isChannelSleeping,
  lastHumanActivity,
} from './sleep.js';
import {
  log,
  sanitizeInput,
  withTimeout,
  rollProbability,
  canSendInChannel,
} from './utils.js';

import { parseIdList } from './utils.js';


/* ========== Config (env) ========== */
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('❌ Missing DISCORD_TOKEN in .env'); process.exit(1); }

const MODE = process.env.ROXI_MODE || 'dev';
const STATUS_PORT = Number(process.env.STATUS_PORT || 0);

// Sleep/wake
const SLEEP_AFTER_MIN     = Number(process.env.ROXI_SLEEP_AFTER_MIN || 60);
const WAKE_MSG_ENABLED    = (process.env.ROXI_WAKE_MSG_ENABLED ?? '0') === '1';
const WAKE_ANNOUNCE_SEC   = Number(process.env.ROXI_WAKE_ANNOUNCE_SEC || 120);

// Momentum / cadence
const MOMENTUM_LOOKBACK_MIN = Number(process.env.ROXI_MOMENTUM_MIN || 20);
const MOMENTUM_MIN_MSGS     = Number(process.env.ROXI_MOMENTUM_MSGS || 10);
const MIN_DISTINCT_SPEAKERS = Number(process.env.ROXI_MIN_SPEAKERS || 3);

const MIN_SPEAKERS_PUBLIC = Number(process.env.ROXI_MIN_SPEAKERS_PUBLIC || 3);
const MIN_SPEAKERS_THREAD = Number(process.env.ROXI_MIN_SPEAKERS_THREAD || 3);

const MIN_REPLY_GAP_MS   = Number(process.env.ROXI_CHANNEL_COOLDOWN_MS || 1000 * 60 * 3);
const USER_GAP_MS        = Number(process.env.ROXI_USER_GAP_MS || 1000 * 20);
const MAX_CONTEXT_MSGS   = Number(process.env.ROXI_MAX_CONTEXT_MSGS || 25);
const MAX_INPUT_CHARS    = Number(process.env.ROXI_MAX_INPUT_CHARS || 800);
const REPLY_PROBABILITY  = Number(process.env.ROXI_REPLY_PROBABILITY || 0.33);

// Proactivity
const CORE_USER_IDS = parseIdList(process.env.ROXI_CORE_USERS);
const PROACTIVE_INTERVAL_MS = Number(process.env.ROXI_PROACTIVE_INTERVAL_MS || 90000);
const PROACTIVE_PROBABILITY = Number(process.env.ROXI_PROACTIVE_PROBABILITY || 0.15);
const KEYWORD = (process.env.ROXI_KEYWORD || 'roxi').toLowerCase();


// Optional channel allowlist (leave empty for all)
const ALLOWED_CHANNELS = (process.env.ROXI_CHANNELS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* ========== Mutable state ========== */
let HARD_MUTE = process.env.ROXI_MUTE === '1';
const lastReplyPerChannel = new Map(); // channelId -> ts

/* ========== Helpers ========== */
function allowedByChannelList(channel) {
  if (ALLOWED_CHANNELS.length === 0) return true;
  return ALLOWED_CHANNELS.includes(channel.name.toLowerCase());
}

function canEvenConsiderSpeaking(channel, lastUserTs) {
  if (HARD_MUTE) return false;
  if (!allowedByChannelList(channel)) return false;
  if (isChannelSleeping(channel.id, { SLEEP_AFTER_MIN })) return false;
  const now = Date.now();
  const last = lastReplyPerChannel.get(channel.id) || 0;
  return (now - last >= MIN_REPLY_GAP_MS) && (now - lastUserTs >= USER_GAP_MS);
}

function conversationEligible(channel) {
  const isThread = channel.isThread?.() ?? false;
  const { speakers } = windowStats(channel.id);

  if (!isThread && speakers < MIN_SPEAKERS_PUBLIC) return false;
  if (isThread && speakers < MIN_SPEAKERS_THREAD) return false;

  return channelIsActive(channel.id, {
    MOMENTUM_LOOKBACK_MIN,
    MOMENTUM_MIN_MSGS,
    MIN_DISTINCT_SPEAKERS,
  });
}

async function maybeAnnounceWake(channel) {
  if (!WAKE_MSG_ENABLED) return;
  // If this is among the first messages after a long sleep, say hi once
  const last = lastHumanActivity.get(channel.id) || 0;
  const justNow = Date.now() - last <= WAKE_ANNOUNCE_SEC * 1000;
  if (justNow) {
    try { await channel.send("☀️ I'm awake! What's going on?"); } catch {}
  }
}

/* ========== Discord client ========== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,     
    GatewayIntentBits.GuildPresences,   
  ],
  partials: [Partials.Channel],
});


client.once(Events.ClientReady, async () => {
  log('info', {
    msg: `Roxi online as ${client.user.tag}`,
    mode: MODE,
    sleepAfterMin: SLEEP_AFTER_MIN,
    momentum: {
      lookbackMin: MOMENTUM_LOOKBACK_MIN,
      minMsgs: MOMENTUM_MIN_MSGS,
      minSpeakers: MIN_DISTINCT_SPEAKERS
    },
    cadence: {
      channelCooldownMs: MIN_REPLY_GAP_MS,
      userGapMs: USER_GAP_MS,
      probability: REPLY_PROBABILITY
    },
    allowChannels: ALLOWED_CHANNELS.length ? ALLOWED_CHANNELS : 'ALL',
  });
  try {
    for (const g of client.guilds.cache.values()) {
      await g.members.fetch({ withPresences: true }).catch(()=>{});
      updateCorePresence(g);
    }
  } catch {}
});

// Ticker
function eligibleChannelsForProactive(guild) {
  const channels = [];
  for (const ch of guild.channels.cache.values()) {
    // text channels only, skip threads; you can refine this if you want threads
    if (ch?.isTextBased?.() && !ch.isThread?.()) {
      // reuse your existing gates
      const lastUserTs = lastHumanActivity.get(ch.id) || 0;
      if (!canEvenConsiderSpeaking(ch, lastUserTs)) continue;
      if (!conversationEligible(ch)) continue;           // momentum + speakers
      if (!canSendInChannel(ch, client.user)) continue;
      channels.push(ch);
    }
  }
  return channels;
}

function startProactiveTicker() {
  if (PROACTIVE_INTERVAL_MS <= 0) return;
  setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        if (!anyCoreOnline(guild)) continue; // only when a core member is online
        const chans = eligibleChannelsForProactive(guild);
        for (const ch of chans) {
          if (Math.random() > PROACTIVE_PROBABILITY) continue;

          // fetch brief context
          const history = await ch.messages.fetch({ limit: Math.min(50, MAX_CONTEXT_MSGS) }).catch(() => null);
          const sorted = history ? [...history.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp) : [];
          const trimmed = sorted.slice(-MAX_CONTEXT_MSGS).map(m => ({
            author: m.author.bot ? 'bot' : (m.member?.displayName || m.author.username),
            content: sanitizeInput(m.cleanContent || '', MAX_INPUT_CHARS),
            ts: m.createdTimestamp,
            isBot: m.author.bot,
          })).filter(m => m.content || !m.isBot);

          if (trimmed.length === 0) continue;

          const reply = await withTimeout(
            onceWithRetry(() => generateReply({
              channel: `#${channelName}`,
              recent: { messages: trimmed, ...windowStats(channel.id), momentum: MOMENTUM_LOOKBACK_MIN },
              mode: MODE,
            })),
            30000
          );

          if (reply && reply.trim()) {
            await ch.send(reply.trim());
            lastReplyPerChannel.set(ch.id, Date.now());
            log('info', { evt: 'send', reason: 'proactive', channel: ch.name });
          }
        }
      }
    } catch (e) {
      log('error', { evt: 'proactive_error', err: e?.message || String(e) });
    }
  }, PROACTIVE_INTERVAL_MS);
}

client.once(Events.ClientReady, () => {
  // ... existing log/init
  startProactiveTicker();
});

const coreOnlineByGuild = new Map(); // guildId -> Set(userId) of online core users

function updateCorePresence(guild) {
  if (!guild?.members?.cache) return;
  const set = new Set();
  for (const uid of CORE_USER_IDS) {
    const m = guild.members.cache.get(uid);
    const status = m?.presence?.status || 'offline'; // 'online'|'idle'|'dnd'|'offline'
    if (status !== 'offline' && status !== 'invisible') set.add(uid);
  }
  coreOnlineByGuild.set(guild.id, set);
  return set;
}
function anyCoreOnline(guild) {
  const set = coreOnlineByGuild.get(guild.id) || new Set();
  return set.size > 0;
}


/* ========== Commands (admin text) ========== */
async function handleAdminCommands(msg) {
  const res = await handleTextCommand(msg, { HARD_MUTE });
  if (res === false) return false;          // no command handled
  if (res === true) return true;            // handled, no state change
  if (res?.HARD_MUTE !== undefined) {       // handled + state change
    HARD_MUTE = res.HARD_MUTE;
    return true;
  }
  return false;
}

/* ========== Main message handler ========== */
client.on(Events.PresenceUpdate, (_, newPresence) => {
  try { updateCorePresence(newPresence?.guild); } catch {}});
client.on(Events.GuildCreate, (g) => { try { updateCorePresence(g); } catch {} });
client.on(Events.GuildMemberAdd, (m) => { try { updateCorePresence(m.guild); } catch {} });

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.inGuild()) return;

    const channel = msg.channel;
    const channelName = channel?.name || '(unknown)';

    // Commands first (admin-only)
    if (await handleAdminCommands(msg)) return;

    // Track activity window and last human activity
    recordActivity(channel.id, msg.author.id, msg.createdTimestamp, {
      MOMENTUM_LOOKBACK_MIN,
    });
    lastHumanActivity.set(channel.id, msg.createdTimestamp);

    // If we just woke up (first messages after a long sleep), optionally say hi
    if (!isChannelSleeping(channel.id, { SLEEP_AFTER_MIN })) {
      await maybeAnnounceWake(channel);
    }

    // ===== Immediate trigger detection =====
    const content = (msg.cleanContent || '').toLowerCase();
    const mentioned = msg.mentions.has(client.user);
    const keywordTrigger = KEYWORD && content.includes(KEYWORD);

    // If mentioned or keyword, bypass momentum but still respect cooldown + sleep + channel allowlist
    if (mentioned || keywordTrigger) {
      const lastUserTs = lastHumanActivity.get(channel.id) || msg.createdTimestamp;
      if (!canEvenConsiderSpeaking(channel, lastUserTs)) return;
      if (!canSendInChannel(channel, client.user)) return;

      const history = await channel.messages.fetch({ limit: Math.min(50, MAX_CONTEXT_MSGS) }).catch(() => null);
      const sorted = history ? [...history.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp) : [];
      const trimmed = sorted.slice(-MAX_CONTEXT_MSGS).map(m => ({
        author: m.author.bot ? 'bot' : (m.member?.displayName || m.author.username),
        content: sanitizeInput(m.cleanContent || '', MAX_INPUT_CHARS),
        ts: m.createdTimestamp,
        isBot: m.author.bot,
      })).filter(m => m.content || !m.isBot);

      const reply = await withTimeout(generateReply({
        channel: `#${channelName}`,
        recent: {
          messages: trimmed,
          ...windowStats(channel.id),
          momentum: MOMENTUM_LOOKBACK_MIN,
        },
        mode: MODE,
      }), 9000);

      if (reply && reply.trim()) {
        await channel.send(reply.trim());
        lastReplyPerChannel.set(channel.id, Date.now());
        log('info', { evt: 'send', reason: mentioned ? 'mention' : 'keyword', channel: channelName });
      }
      return; // don’t also run the organic path
    }

    // Global gates
    const lastUserTs = lastHumanActivity.get(channel.id) || msg.createdTimestamp;
    if (!canEvenConsiderSpeaking(channel, lastUserTs)) return;
    if (!conversationEligible(channel)) return;
    if (!canSendInChannel(channel, client.user)) {
      log('warn', { evt: 'no_send_perm', channel: channelName }); return;
    }

    // Build recent context
    const history = await channel.messages.fetch({ limit: Math.min(50, MAX_CONTEXT_MSGS) }).catch(() => null);
    const sorted = history ? [...history.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp) : [];
    const trimmed = sorted.slice(-MAX_CONTEXT_MSGS).map(m => ({
      author: m.author.bot ? 'bot' : (m.member?.displayName || m.author.username),
      content: sanitizeInput(m.cleanContent || '', MAX_INPUT_CHARS),
      ts: m.createdTimestamp,
      isBot: m.author.bot,
    })).filter(m => m.content || !m.isBot);

    if (trimmed.length === 0) return;

    // Final randomness
    if (!rollProbability(REPLY_PROBABILITY)) return;

    // AI (swap in your LLM/RAG inside generateReply)
    const reply = await withTimeout(generateReply({
      channel: `#${channelName}`,
      recent: {
        messages: trimmed,
        ...windowStats(channel.id),
        momentum: MOMENTUM_LOOKBACK_MIN,
      },
      mode: MODE,
    }), 9000);

    if (reply && reply.trim()) {
      await channel.send(reply.trim());
      lastReplyPerChannel.set(channel.id, Date.now());
      log('info', {
        evt: 'send',
        channel: channelName,
        bytes: reply.length,
        recentMsgs: trimmed.length
      });
    }
  } catch (err) {
    log('error', { evt: 'handler_error', err: err?.message || String(err) });
  }
});

/* ========== Health endpoint (optional) ========== */
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

/* ========== Boot ========== */
client.login(TOKEN).catch((e) => {
  console.error('❌ Login failed:', e?.message || e);
  process.exit(1);
});