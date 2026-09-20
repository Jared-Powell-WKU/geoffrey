require('dotenv').config();
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Collection, Client, Events, GatewayIntentBits, Partials, PartialUser, User, MessageReaction, PartialMessageReaction } from 'discord.js'
import { interactionHandler, saveAttachmentsFromMessage, checkPinLimit, checkForImageDeletion, deleteSubmissionsOfDeletedMessage, deleteSubmissionsOfDeletedMessages } from './events';
import { DiscordCommand } from './util/commandHelper';
import { checkEvPortStatus } from './util/checkEvPortStatus';
import { GuildDictionary, query, transaction } from './util/util';
import { startHealthHeartbeat } from './util/health';
import { startInternalApi } from './internalApi';
import { startOriginBackfill } from './maintenance/backfillOrigins';

const client = new Client({
    intents:[GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});
client.commands = new Collection();

// Load commands from both 'commands' and 'commands-clantus'
const commandDirs = ['commands', 'commands-clantus'];
for (const dir of commandDirs) {
    const commandsPath = path.join(__dirname, dir);
    if (!fs.existsSync(commandsPath)) continue;
    const commandFiles = fs.readdirSync(commandsPath).filter((file: string) => file.endsWith('.js') || file.endsWith('.ts'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        let command = require(filePath);
        if (command?.default) command = command.default;
        if (Array.isArray(command)) {
            command.forEach((c: any) => {
                if ('data' in c && 'execute' in c) {
                    client.commands.set(c.data.name, c);
                }
            });
        } else if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        }
    }
}

client.once(Events.ClientReady, (c: Client)=> {
    console.info(`Ready! Logging in as ${c.user?.tag}`)
    startHealthHeartbeat(c);
    // Looks up the original message of old submissions, a few requests at a time.
    startOriginBackfill({client: c, query});
})
client.login(process.env.CLIENT_TOKEN);
startInternalApi({client, query, transaction});

client.on(Events.InteractionCreate, interactionHandler);
client.on(Events.MessageCreate, saveAttachmentsFromMessage);
client.on(Events.MessageDelete, deleteSubmissionsOfDeletedMessage);
client.on(Events.MessageBulkDelete, deleteSubmissionsOfDeletedMessages);
client.on(Events.MessageReactionAdd, async(reaction: MessageReaction|PartialMessageReaction, user: User|PartialUser)=>{return await checkForImageDeletion(reaction, user, client)})

let portsAvailable: boolean = false;

async function checkAndReportEvPortStatus() {
    try {
        const status = await checkEvPortStatus();

        if (portsAvailable !== status) { 
            const guilds: GuildDictionary = JSON.parse(process.env.GUILDS || '{}');
            const targetGuild = client.guilds.cache.find(guild => guild.id === guilds?.clantus?.guildId);
            if (!targetGuild) {
                console.warn('Target guild for Clantus not found. Please check the GUILDS environment variable.');
                return;
            }
            const role = targetGuild.roles.cache.find(r => r.name === 'ev-notifications');
            const roleMention = role ? `<@&${role.id}> ` : '';
            if (targetGuild) {
                const channel = targetGuild.channels.cache.find(ch => ch.name === 'ev-watcher');
                if (channel && channel.isTextBased()) {
                    const fetched = await channel.messages.fetch({ limit: 50 });
                    const botMessages = fetched.filter(msg => msg.author.id === client.user?.id);
                    if (botMessages.size > 0) {
                        await channel.bulkDelete(botMessages, true).catch(() => {});
                    }
                    await channel.send(`${roleMention}EV Port Status: ${status ? 'Available' : 'Not Available'} (checked at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })})`);
                } else {
                    console.warn('Channel "ev-watcher" not found or is not a text channel.');
                }
            }
            portsAvailable = status;
        } else {
            // Find the target guild and channel
            const guilds: GuildDictionary = JSON.parse(process.env.GUILDS || '{}');
            const targetGuild = client.guilds.cache.find(guild => guild.id === guilds?.clantus?.guildId);
            if (!targetGuild) return;
            const role = targetGuild.roles.cache.find(r => r.name === 'ev-notifications');
            const roleMention = role ? `<@&${role.id}> ` : '';
            const channel = targetGuild.channels.cache.find(ch => ch.name === 'ev-watcher');
            if (channel && channel.isTextBased()) {
                const fetched = await channel.messages.fetch({ limit: 10 });
                const botMessages = fetched.filter(msg => msg.author.id === client.user?.id);
                const latestBotMsg = botMessages.first();
                if (latestBotMsg) {
                    await latestBotMsg.edit(`${roleMention}EV Port Status: ${status ? 'Available' : 'Not Available'} (checked at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })})`);
                }
            }
        }
        console.log(`[EV Port Status] ${status ? 'Available' : 'Not Available'} (checked at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })})`);
    } catch (error) {
        console.error(`[EV Port Status] Error checking status: ${error}`);
    }
}

// Run immediately on startup
// checkAndReportEvPortStatus();

// Then every 5 minutes
// setInterval(checkAndReportEvPortStatus, 1000 * 60 * 5);