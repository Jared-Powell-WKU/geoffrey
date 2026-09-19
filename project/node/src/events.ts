import { ChatInputCommandInteraction, Collection, GuildMember, Message, MessageReaction, PartialMessage, PartialMessageReaction, Client, MessageFlags, TextChannel, Interaction, PartialUser, ReadonlyCollection, User } from "discord.js";
import { DiscordCommand } from "./util/commandHelper";
import { saveAttachments, deleteImage, deleteImagesForMessages, getTableByCommandName, GuildDictionary, SupportedGuild } from "./util/util";
import { getStoredUrlFromContent } from "./util/storedUrl";
require('dotenv').config();
if(!process.env.GUILDS) {
    throw 'There was a problem getting guild data';
}
const guilds: GuildDictionary = JSON.parse(process.env.GUILDS);
declare module 'discord.js' {
    interface Client {
        commands: Collection<string, DiscordCommand>
    }
}
// Interactions
export const interactionHandler = async (interaction: Interaction) => {
    if(!interaction.isChatInputCommand()) return;
    try {
        const command = interaction.client.commands.get(interaction.commandName);
        if(!command) {
            throw `Unable to locate command ${interaction.commandName}`
        }
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        await interaction.reply({content:"There was an error while executing this command!", flags: MessageFlags.Ephemeral})
    }
}

// Messages
export const saveAttachmentsFromMessage = async function(message: Message) {
    try {
        const {channelId, member, guildId} = message;
        if(member?.user && member.user.bot) return;
        const activeGuild: SupportedGuild = Object.values(guilds).filter((g)=>{return g.guildId == guildId})[0] || false;
        if(!activeGuild) return;
        if(message.attachments) {
            let saved = null;
            const {attachments} = message;
            const origin = {channelId, messageId: message.id, createdAt: message.createdAt};
            if(activeGuild.channels.homies.includes(channelId)) {
                saved = await saveAttachments(attachments, guildId, getTableByCommandName("homies"), member?.user.id, origin);
            } else if(activeGuild?.channels.pets.includes(channelId)) {
                saved = await saveAttachments(attachments, guildId, getTableByCommandName("cute"), member?.user.id, origin);
            } else {
                return;
            }
            if(saved) {
                message.react('📸');
            }
        } 
    } catch(e) {
        console.error(e);
        return;
    }
}

// Deletions
// A submission whose Discord message is gone 404s on the site and in rolls, and
// whoever deleted the message meant it, so its rows are deleted outright.
// With partials on, an uncached message arrives with
// only its ids, which is enough for rows that recorded a messageId; a cached
// one also brings its attachments, which finds rows from before messageId existed.
const deleteSubmissionsOfMessages = async (guildId: string|null, messages: (Message|PartialMessage)[]) => {
    try {
        if(!guildId || !messages.length) return;
        const activeGuild = Object.values(guilds).filter((g)=>{return g.guildId === guildId})[0];
        if(!activeGuild) return;
        // proxyURL too: a few old rows were stored with the media.discordapp.net form.
        const attachmentUrls = messages.flatMap(message => [...(message.attachments?.values() ?? [])]).flatMap(attachment => [attachment.url, attachment.proxyURL]);
        const deleted = await deleteImagesForMessages(guildId, messages.map(message => message.id), attachmentUrls, "message_deleted");
        if(deleted) console.info(`Deleted ${deleted} stored submission(s) of ${messages.length} deleted message(s) in guild ${guildId}.`);
    } catch(e) {
        console.error(`Unable to delete the submissions of ${messages.length} deleted message(s) in guild ${guildId}.`, e);
    }
}

export const deleteSubmissionsOfDeletedMessage = async (message: Message|PartialMessage) => {
    await deleteSubmissionsOfMessages(message.guildId, [message]);
}

export const deleteSubmissionsOfDeletedMessages = async (messages: ReadonlyCollection<string, Message|PartialMessage>) => {
    const all = [...messages.values()];
    await deleteSubmissionsOfMessages(all[0]?.guildId ?? null, all);
}

// Pins
export const checkPinLimit = async(textChannel: TextChannel) => {
    const pinned = await textChannel.messages.fetchPinned();
    console.log("Pinned messages: ", pinned.size);
    if(pinned.size == 50) textChannel.send("Pin Limit Reached");
}

// Reacts
export const checkForImageDeletion = async (reaction: MessageReaction|PartialMessageReaction, user:User|PartialUser, client:Client) => {
    const {CLIENT_ID} = process.env;
    const {message} = reaction;
    if(!message) {
        throw 'Unable to get message from reaction';
    }
    const activeGuild: SupportedGuild = Object.values(guilds).filter((g)=>{return g.guildId === message.guildId})[0] || false;
    if(!activeGuild) {
        console.info("No active clan for reaction.", message.guildId)
        return;
    }
    let completeMessageReaction: MessageReaction;
    if (reaction.partial) {
        try {
            completeMessageReaction = await reaction.fetch();
        } catch (error) {
            console.error('Something went wrong when fetching the message:', error);
            return;
        }
    } else {
        completeMessageReaction = reaction;
    }
    try {
        if(message?.author?.id == CLIENT_ID) {
            const image = getStoredUrlFromContent(message.content);
            if(!image) return;
            if(!message.guildId) {
                throw 'Missing guild id';
            }
            const guild = client.guilds.cache.get(message.guildId);
            if(!guild) {
                throw 'Unable to get guildId from message';
            }
            const member = await guild.members.fetch(user.id);
            const roles = member.roles.cache.map(role => role.name);
            const isMod = roles.includes(activeGuild.adminRoleName)
            if((isMod && completeMessageReaction.emoji.name == '💣') || (completeMessageReaction.emoji.name == '❌' && completeMessageReaction.count >= 5)) {
                let purged = await deleteImage(image, message.guildId, "removed_by_reaction");
                // Bot messages that merely contain a link (a bracket, say) are not rolls,
                // and must not disappear because a mod reacted to them.
                if(!purged) console.info(`Nothing stored matched ${image}; leaving message ${message.id} alone.`);
                else if(isMod) await message.delete();
            }
            if(completeMessageReaction.emoji.name == '❌' && completeMessageReaction.count <= 5) console.info(`Image ${image} has ${completeMessageReaction.count} votes to remove.`);
        } else if(activeGuild.channels.homies.includes(message.channelId) || activeGuild.channels.pets.includes(message.channelId)) {
            let guildId = message?.guildId;
            if(!guildId) {
                throw 'Message missing guildId.'
            }
            const guild = client.guilds.cache.get(guildId);
            if(!guild) {
                throw 'Unable to get guild from cache.'
            }
            const member = await guild.members.fetch(user.id);
            const roles = member.roles.cache.map(role => role.name);
            const isMod = roles.includes(activeGuild.adminRoleName);
            if((isMod || message?.author?.id == user.id) && completeMessageReaction.emoji.name == '❌') {
                // proxyURL too: a few old rows were stored with the media.discordapp.net form.
                const attachmentUrls = [...message.attachments.values()].flatMap(attachment => [attachment.url, attachment.proxyURL]);
                let deleted: number;
                try {
                    deleted = await deleteImagesForMessages(guildId, [message.id], attachmentUrls, "removed_by_reaction");
                } catch(e) {
                    // The rows may still exist, so the camera has to keep saying so.
                    console.error(`Unable to remove the submissions of message ${message.id}; its reaction stays.`, e);
                    return;
                }
                // The deletes ran and matched nothing, so nothing is stored for this
                // message and a camera left on it is stale.
                if(!deleted) console.info(`No stored submission matched message ${message.id} (${attachmentUrls.length / 2} attachments); clearing its camera reaction.`);
                else console.info(`Removed ${deleted} stored submission(s) of message ${message.id}.`);
                if(message.reactions) {
                    await message.reactions.resolve('📸')?.users.remove();
                }
            }
        }
    } catch(e) {
        console.error(e);
    }
}