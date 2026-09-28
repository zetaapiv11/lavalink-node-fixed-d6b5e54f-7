// ZetaPanel Discord Bot Template
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const prefix = process.env.PREFIX || '!';

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log('Ready and listening for commands.');
});

client.on('messageCreate', message => {
  if (message.author.bot) return;
  if (message.content === `${prefix}ping`) {
    message.reply('Pong! Powered by ZetaPanel on Render & Cloudflare R2.');
  }
});

if (!token) {
  console.error('FATAL: BOT_TOKEN or DISCORD_TOKEN environment variable is not defined.');
  process.exit(1);
}

client.login(token);