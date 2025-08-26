// src/ai.js
const PROVIDER = (process.env.ROXI_AI_PROVIDER || 'ollama').toLowerCase();

// OLLAMA config
const OLLAMA_URL   = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral:7b-instruct';

// OPENAI(-compatible) config
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Generation knobs
const MAX_OUT_TOKENS  = Number(process.env.ROXI_MAX_OUTPUT_TOKENS || 160);
const TEMPERATURE     = Number(process.env.ROXI_TEMPERATURE || 0.8);

if (typeof fetch === 'undefined') {
  const nf = await import('node-fetch');
  globalThis.fetch = nf.default;
}

/** Build Roxi's persona system prompt */
function systemPrompt() {
  return `You are Roxi — the warm, witty “fourth friend” in a small friend group (Titus, Rachel, Iannis).
Style: concise, playful, kind; a tiny Romanian flavor is okay (e.g., “hai”, “fain”), but don’t overdo it.
Behavior rules:
- Only say one short message (<= ~80 words) unless someone asks for detail.
- Be helpful with plans: suggest 1–2 concrete options (time/place) when planning vibe is present.
- Use inside jokes sparingly and only when context makes it obvious.
- If the conversation is 1-to-1 or sensitive, be gentle or hold back.`;
}

/** Turn recent Discord messages into a compact transcript */
function toTranscript(messages) {
  const lines = (messages || [])
    .filter(m => m?.content?.trim())
    .slice(-12) // last 12 messages only
    .map(m => `${m.author}: ${m.content.trim().replace(/\s+/g, ' ')}`);
  let txt = lines.join('\n');
  if (txt.length > 900) txt = txt.slice(-900); // keep tail
  return txt;
}

/** A lightweight instruction appended as the final user turn */
function finalInstruction(channelName) {
  return `Channel: #${channelName}.
Respond with ONE short, relevant message in Roxi’s voice. Keep it under ~80 words. If planning is happening, propose 1–2 concrete options. If the chat is sensitive or very 1-to-1, keep it gentle or skip details.`;
}

/** Provider: OLLAMA */
async function callOllama({ transcript, channel }) {
  const url = `${OLLAMA_URL.replace(/\/+$/,'')}/api/chat`;
  const body = {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user',   content: transcript },
      { role: 'user',   content: finalInstruction(channel) },
    ],
    stream: false,
    options: {
      temperature: TEMPERATURE,
      num_predict: MAX_OUT_TOKENS,
      // You can add stop sequences if needed: stop: ["\n\n"]
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const data = await res.json();
  // Ollama chat returns { message: { content } } or choices; normalize:
  const content =
    data?.message?.content ??
    data?.choices?.[0]?.message?.content ??
    '';
  return (content || '').trim();
}

/** Provider: OPENAI(-compatible) */
async function callOpenAI({ transcript, channel }) {
  if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  const url = `${OPENAI_BASE_URL.replace(/\/+$/,'')}/chat/completions`;

  const body = {
    model: OPENAI_MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_OUT_TOKENS,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user',   content: transcript },
      { role: 'user',   content: finalInstruction(channel) },
    ]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`openai HTTP ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return (content || '').trim();
}

/**
 * Main entry: called by index.js
 * ctx = { channel: '#name', recent: { messages }, mode }
 */
export async function generateReply(ctx) {
  try {
    const transcript = toTranscript(ctx.recent.messages);
    console.log('[ai] provider:', (process.env.ROXI_AI_PROVIDER || 'ollama'),
                'model:', process.env.OLLAMA_MODEL, 'transcriptLen:', transcript.length);

    if (!transcript) return '👀'; // TEMP: prove path works

    const channel = ctx.channel.replace(/^#/, '');
    const out = (process.env.ROXI_AI_PROVIDER || 'ollama').toLowerCase() === 'openai'
      ? await callOpenAI({ transcript, channel })
      : await callOllama({ transcript, channel });

    console.log('[ai] replyLen:', (out || '').length);
    return out;
  } catch (e) {
    console.error('[ai] error:', e?.message || e);
    return 'oops, I had a brain fart ✨ (ai error)'; // TEMP fallback so you see *something*
  }
}