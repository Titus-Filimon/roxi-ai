// src/ai.js

// Ensure fetch exists on Node < 18
if (typeof fetch === 'undefined') {
  const nf = await import('node-fetch');
  globalThis.fetch = nf.default;
}

const PROVIDER = (process.env.ROXI_AI_PROVIDER || 'ollama').toLowerCase();

// OLLAMA config
const OLLAMA_URL   = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/,'');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct'; // speedy default while debugging

// OPENAI(-compatible) config (unused if provider=ollama)
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/,'');
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Generation knobs (keep small for speed)
const MAX_OUT_TOKENS  = Math.min(Number(process.env.ROXI_MAX_OUTPUT_TOKENS || 60), 80);
const TEMPERATURE     = Number(process.env.ROXI_TEMPERATURE || 0.6);

// Timeouts tuned for snappy feel (index.js wraps at 26s)
const TTFT_TIMEOUT_MS  = Number(process.env.ROXI_TTFT_TIMEOUT_MS  || 15000); // time-to-first-token
const TOTAL_TIMEOUT_MS = Number(process.env.ROXI_TOTAL_TIMEOUT_MS || 25000); // total stream budget

/** Persona — short to reduce tokens */
function systemPrompt() {
  return `Sassy friend.`;
}

/** Very compact transcript */
function toTranscript(messages) {
  const lines = (messages || [])
    .filter(m => m?.content?.trim())
    .slice(-6) // last 6 msgs only
    .map(m => `${m.author}: ${m.content.trim().replace(/\s+/g, ' ')}`);
  let txt = lines.join('\n');
  if (txt.length > 480) txt = txt.slice(-480); // hard cap
  return txt;
}

function userInstruction(channelName) {
  return `Channel: #${channelName}. Reply with ONE short, relevant line in Roxi's voice.`;
}

/** ===== OLLAMA (streaming, early-return WITHOUT aborts) ===== */
async function callOllamaStream({ transcript, channel }) {
  const url = `${OLLAMA_URL}/api/chat`;
  const body = {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user',   content: transcript || 'Say hi briefly.' },
      { role: 'user',   content: userInstruction(channel) },
    ],
    stream: true,
    options: {
      temperature: TEMPERATURE,
      num_predict: MAX_OUT_TOKENS,
      num_ctx: 768,              // smaller context => faster TTFT
      keep_alive: '2h',
      stop: ["\n", "\n\n"]       // encourage single-line output
    }
  };

  const controller = new AbortController();
  const ttftTimer  = setTimeout(() => controller.abort('ttft'),  TTFT_TIMEOUT_MS);
  const totalTimer = setTimeout(() => controller.abort('total'), TOTAL_TIMEOUT_MS);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'connection': 'keep-alive' },
    body: JSON.stringify(body),
    signal: controller.signal
  }).catch(e => { clearTimeout(ttftTimer); clearTimeout(totalTimer); throw e; });

  clearTimeout(ttftTimer);
  if (!res.ok) {
    clearTimeout(totalTimer);
    const text = await res.text().catch(()=> '');
    throw new Error(`ollama HTTP ${res.status}: ${text.slice(0,200)}`);
  }

  // Read stream; stop reading when we have a first sentence — but DO NOT abort the fetch.
  // Just break the loop and return what we have. No "early" errors anywhere.
  let out = '';
  let gotAny = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttftSeen = false;

  try {
    while (true) {
      const race = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ttft_timeout')), TTFT_TIMEOUT_MS))
      ]);

      if (race && race.value === undefined && race.done === undefined) {
        // the timeout branch fired — bail with what we have (maybe nothing)
        throw new Error('ttft_timeout');
      }

      const { value, done } = race;
      if (done) break;

      gotAny = true;
      if (!ttftSeen) ttftSeen = true;

      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const json = JSON.parse(s);
          const piece = json?.message?.content || '';
          if (piece) {
            out += piece;
            const t = out.trim();
            // Return once we have a plausible first sentence
            if (t.length >= 16 && /[.!?]\s?$/.test(t)) {
              // stop reading more; break both loops safely
              reader.cancel().catch(()=>{});
              const trimmed = t.split('\n')[0].slice(0, 300);
              clearTimeout(totalTimer);
              return trimmed;
            }
          }
        } catch { /* ignore non-JSON lines */ }
      }
    }
  } catch (e) {
    // If TTFT timed out but we already got something, return it; otherwise bubble
    if ((e?.message === 'ttft_timeout' || String(e).includes('ttft')) && out.trim()) {
      const trimmed = out.trim().split('\n')[0].slice(0, 300);
      clearTimeout(totalTimer);
      return trimmed;
    }
    clearTimeout(totalTimer);
    throw e;
  }

  clearTimeout(totalTimer);
  const trimmed = (out || '').trim();
  if (!trimmed && !gotAny) throw new Error('ollama no-stream');
  return trimmed.split('\n')[0].slice(0, 300);
}

/** ===== OpenAI(-compatible) non-stream (kept simple) ===== */
async function callOpenAI({ transcript, channel }) {
  if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  const url = `${OPENAI_BASE_URL}/chat/completions`;
  const body = {
    model: OPENAI_MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_OUT_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user',   content: transcript || 'Say hi briefly.' },
      { role: 'user',   content: userInstruction(channel) },
    ]
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`openai HTTP ${res.status}: ${t.slice(0,200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return (data?.choices?.[0]?.message?.content || '').trim();
}

/** Entry */
export async function generateReply(ctx) {
  try {
    const transcript = toTranscript(ctx.recent.messages);
    const channel = ctx.channel.replace(/^#/, '');

    if (!transcript) return '👀';

    const out = (PROVIDER === 'openai')
      ? await callOpenAI({ transcript, channel })
      : await callOllamaStream({ transcript, channel });

    return (out || '👀').trim();
  } catch (e) {
    console.error('[ai] error:', e?.message || e);
    return 'brb—tiny brain lag';
  }
}

/** Warm-up (stream path, tiny prompt). Returns true if any non-empty text produced. */
export async function warmup() {
  try {
    const out = (PROVIDER === 'openai')
      ? await callOpenAI({ transcript: 'Say hi briefly.', channel: 'warmup' })
      : await callOllamaStream({ transcript: 'hi', channel: 'warmup' });
    return !!(out && out.trim());
  } catch (e) {
    // If we got here, it’s a real error (not early-stop), log and return false
    console.error('[ai] warmup error:', e?.message || e);
    return false;
  }
}

export async function aiHealth() {
  try {
    const base = (PROVIDER === 'openai') ? OPENAI_BASE_URL : OLLAMA_URL;
    const url = (PROVIDER === 'openai') ? `${base}/models` : `${base}/api/tags`;
    const headers = (PROVIDER === 'openai') ? { authorization: `Bearer ${OPENAI_API_KEY}` } : {};
    const r = await fetch(url, { headers });
    return r.ok;
  } catch { return false; }
}
