import { PermissionsBitField } from 'discord.js';
import { warmup } from './ai.js';

/**
 * Admin text commands (must be sent in a guild text channel):
 *  - "roxi mute"    → HARD_MUTE = true
 *  - "roxi unmute"  → HARD_MUTE = false
 *  - "roxi warmup"  → run AI warm-up ping
 *
 * Return values:
 *  - false → not handled
 *  - true  → handled, no state change
 *  - { HARD_MUTE: boolean } → handled + state update
 */
export function handleTextCommand(msg, state) {
  const text = (msg.content || '').trim().toLowerCase();
  const isAdmin = msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) return false;

  if (text === 'roxi mute') {
    msg.channel.send('🔇 Roxi muted by admin.').catch(() => {});
    return { HARD_MUTE: true };
  }

  if (text === 'roxi unmute') {
    msg.channel.send('🔊 Roxi unmuted by admin.').catch(() => {});
    return { HARD_MUTE: false };
  }

  if (text === 'roxi warmup') {
    (async () => {
      const ok = await warmup();
      msg.channel.send(ok ? '🔥 warmed up' : '❄️ warmup failed').catch(()=>{});
    })();
    return true;
  }

  return false;
}
