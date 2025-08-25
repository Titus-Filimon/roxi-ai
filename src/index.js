import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';

// Create the client with needed intents.
// Add GuildMembers/GuildPresences later if you want presence-gating.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,            // basic guild info
    GatewayIntentBits.GuildMessages,     // receive messages
    GatewayIntentBits.MessageContent,    // read message text
  ],
  partials: [Partials.Channel],          // helps with some cached channels
});

// Simple health log
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// Minimal behavior: reply when mentioned, or if channel name contains "bot"
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;               // ignore other bots
    if (!msg.inGuild()) return;               // ignore DMs for now

    const channelName = msg.channel?.name?.toLowerCase() || '';
    const mentioned = msg.mentions.has(client.user);

    if (mentioned || channelName.includes('bot')) {
      // Keep it short; you can swap this text for an LLM call later.
      await msg.reply(`hey, I’m alive ✨`);
    }
  } catch (err) {
    console.error('Message handler error:', err);
  }
});

// Always last: login
client.login(process.env.DISCORD_TOKEN);
