import { PermissionsBitField } from 'discord.js';

export function parseIdList(envVal) {
  return (envVal || '').split(',').map(s=>s.trim()).filter(Boolean);
}

export function log(lvl, obj = {}) {
  console.log(JSON.stringify({ lvl, ts: new Date().toISOString(), ...obj }));
}

const BANNED_RE = /(password|api[_\- ]?key|token|ssn|secret|private key|seed phrase)/i;

export function sanitizeInput(text, maxLen = 800) {
  if (!text) return '';
  const t = String(text).slice(0, maxLen);
  if (BANNED_RE.test(t)) return '';
  return t;
}

// utils.js
export async function withTimeout(promise, ms = 30000) { // 30s
  let t; const timer = new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)));
  try { return await Promise.race([promise, timer]); }
  finally { clearTimeout(t); }
}

export async function onceWithRetry(fn) {
  try { return await fn(); } catch (_) { return await fn(); }
}


export function rollProbability(p = 0.33) {
  return Math.random() < p;
}

export function canSendInChannel(ch, clientUser) {
  const perms = ch?.permissionsFor?.(clientUser);
  return perms?.has?.(PermissionsBitField.Flags.SendMessages);
}
