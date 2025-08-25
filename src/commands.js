import { PermissionsBitField } from 'discord.js';

/**
 * Admin text commands:
 *  - "roxi mute"   -> HARD_MUTE = true
 *  - "roxi unmute" -> HARD_MUTE = false
 *
 * Returns:
 *  - false: not handled
 *  - true: handled without state change
 *  - { HARD_MUTE: boolean }: handled with state change
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
  return false;
}
