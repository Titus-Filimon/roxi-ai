/**
 * Placeholder AI: replace this with your LLM/RAG call.
 * ctx = {
 *   channel: '#name',
 *   recent: { messages: [{author, content, ts, isBot}], speakers, count, momentum },
 *   mode: 'dev'|'prod'
 * }
 */
export async function generateReply(ctx) {
  const { speakers, count } = ctx.recent;
  const vibe = speakers >= 5 ? 'buzzing' : (speakers >= 3 ? 'active' : 'quiet');
  // Keep it short; your LLM should do the real work later.
  return `channel’s ${vibe} (${count} msgs / ${speakers} people) — what’s the plan?`;
}
