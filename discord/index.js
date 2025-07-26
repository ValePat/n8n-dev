import { Client, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';
import axios from 'axios';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Bot connesso come ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // Ignora i messaggi dei bot
  console.log(`Messaggio ricevuto: ${message.content}`);
      try {
        const response = await axios.post(process.env.N8N_DISCORD_WEBHOOK_DEV, 
          {
            user: message.author.username,
            text: message.content
          }
        );
    
    console.log('Risposta da n8n:', response.data);
    // Se n8n risponde con un campo "text"
    if (response.data && response.data.text) {
      await message.reply(response.data.text);
    } else if (response.data && response.data.reply) {
      // Supporto per risposta "reply" se usata nel workflow
      await message.reply(response.data.reply);
    } else {
      await message.reply('Ho ricevuto la tua richiesta!');
    }

  } catch (error) {
    console.error('Errore:', error);
    await message.reply('Errore nella comunicazione con n8n.');
  }
  
});

client.login(process.env.DISCORD_BOT_TOKEN);
