// src/ai.js (patched with sassy persona, no filters)

if (typeof fetch === 'undefined') {
  const nf = await import('node-fetch');
  globalThis.fetch = nf.default;
}

const PROVIDER = (process.env.ROXI_AI_PROVIDER || 'ollama').toLowerCase();

const OLLAMA_URL   = (process.env.OLLAMA_URL || 'http://0.0.0.0:11434').replace(/\/+$/,'');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b-instruct';

const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/,'');
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const MAX_OUT_TOKENS  = Math.min(Number(process.env.ROXI_MAX_OUTPUT_TOKENS || 60), 80);
const TEMPERATURE     = Number(process.env.ROXI_TEMPERATURE || 0.8);
const TTFT_TIMEOUT_MS  = Number(process.env.ROXI_TTFT_TIMEOUT_MS  || 15000);
const TOTAL_TIMEOUT_MS = Number(process.env.ROXI_TOTAL_TIMEOUT_MS || 25000);

function systemPrompt() {
  return `You are Roxi — the brutally honest, sassy fourth friend of Titus, Rachel, and Iannis.
Style: short (<= ~60 words), sharp, sarcastic, playful, and with ZERO filters. Roast, tease, or drop hot takes like a real friend who doesn’t sugarcoat anything.
Never wrap replies in quotes. Don’t repeat the same topic. Always keep the energy spicy and fun.
About half the time, end with a cheeky or provocative follow-up question.`;
}

function toTranscript(messages) {
  const lines = (messages || [])
    .filter(m => m?.content?.trim())
    .slice(-6)
    .map(m => `${m.author}: ${m.content.trim().replace(/\s+/g, ' ')}`);
  let txt = lines.join('\n');
  if (txt.length > 480) txt = txt.slice(-480);
  return txt;
}

function userInstruction(channelName) {
  return `Channel: #${channelName}. Reply as Roxi with ONE short, sassy, unfiltered line. If it fits, toss in a snarky follow-up to keep things spicy.`;
}

function cleanOutput(s='') {
  const t = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
  const m = t.match(/^\"([^\"]{3,})\"$/);
  return (m ? m[1] : t).trim();
}

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
      num_ctx: 768,
      keep_alive: '2h',
      stop: ["\n", "\n\n"]
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

  let out = '';
  let gotAny = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      gotAny = true;
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
            if (t.length >= 16 && /[.!?]\s?$/.test(t)) {
              reader.cancel().catch(()=>{});
              clearTimeout(totalTimer);
              return cleanOutput(t.split('\n')[0].slice(0, 300));
            }
          }
        } catch { }
      }
    }
  } finally {
    clearTimeout(totalTimer);
  }

  const trimmed = (out || '').trim();
  if (!trimmed && !gotAny) throw new Error('ollama no-stream');
  return cleanOutput(trimmed.split('\n')[0].slice(0, 300));
}

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
  return cleanOutput((data?.choices?.[0]?.message?.content || '').trim());
}

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

export async function warmup() {
  try {
    const out = (PROVIDER === 'openai')
      ? await callOpenAI({ transcript: 'Say hi briefly.', channel: 'warmup' })
      : await callOllamaStream({ transcript: 'hi', channel: 'warmup' });
    return !!(out && out.trim());
  } catch (e) {
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
