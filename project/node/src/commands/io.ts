import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, PermissionsBitField } from 'discord.js'
import { DiscordCommand } from '../util/commandHelper';
import { getPhotoFromTable, getTableByCommandName } from '../util/util';
const { setInputOutputValue, getInputOutputValue } = require('../util/util')

const defaultExecute = async (interaction: ChatInputCommandInteraction)=>{
    const {guildId, commandName} = interaction;
    let response = "There was an error. Please try again later."
    try {
        const userReg = new RegExp(/(\d+)/);
        const user = interaction.options.getString("user") || false;
        const userId = user ? user.match(userReg)?.[1] : null;
        let winner = await getPhotoFromTable(guildId, (userId || null), getTableByCommandName(commandName));
        if(!winner) throw "An unknown error occurred";
        else {
            const message = interaction.options.getString("message") || "";
            response = winner+(message ? "\n\n"+message : "");
            if(user) response += `\nPhoto compliments of ${user}`;
        }
        interaction.reply(response);
    } catch(e) {
        console.error(`Homies error at ${new Date().toLocaleDateString('en-us', { weekday:"long", year:"numeric", month:"short", day:"numeric"})}:`, e);
        let errorContent = "There was a problem. Please try again or contact Cantus";
        switch(commandName) {
            case "homies":
                errorContent = "There was a problem getting your homie. Please try again or contact Cantus"
                break;
            case "cute":
                errorContent = "There was a problem getting your cute animal. Please try again or contact Cantus";
                break;
        }
        interaction.reply({content:errorContent, flags:MessageFlags.Ephemeral})
    }
}
const commands: Record<string, DiscordCommand> = {
    setbracket: {
        data: new SlashCommandBuilder()
            .setName("setbracket")
            .addStringOption((option=>option.setName("link").setDescription("Allows moderator to update bracket link").setRequired(true)))
            .setDescription("Updates bracket link")
            .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers),
        async execute(interaction: ChatInputCommandInteraction) {
            const {guildId, member} = interaction;
            const bracketUrl = interaction.options.getString("link");
            if(!bracketUrl) {
                interaction.reply({content:"Error: no bracket provided", flags:MessageFlags.Ephemeral})
            }
            const updated = await setInputOutputValue(guildId, "bracket", bracketUrl, member?.user.id);
            if(updated) {
                await interaction.reply(bracketUrl || "");
            } else {
                await interaction.reply({content:"Sorry, but the bracket could not be updated.", flags:MessageFlags.Ephemeral})
            }
        }
    },
    bracket: {
        data: new SlashCommandBuilder()
            .setName("bracket")
            .setDescription("Retrieves latest bracket"),
        async execute(interaction: ChatInputCommandInteraction) {
            const {guildId} = interaction;
            const bracketUrl = await getInputOutputValue(guildId, "bracket");
            if(bracketUrl) {
                await interaction.reply(bracketUrl);
            } else {
                await interaction.reply({content:"There was no bracket found.", flags:MessageFlags.Ephemeral})
            }
        }
    },
    cute: {
        data: new SlashCommandBuilder()
            .setName('cute')
            .setDescription('Posts a random image from the Pets channel')
            .addStringOption((option=>option.setName("message").setDescription("Add a little flavor to your pet roll.")))
            .addStringOption((option=>option.setName("user").setDescription("Tag a user to get their uploads"))),
        execute: defaultExecute
    },
    homies: {
        data: new SlashCommandBuilder()
            .setName('homies')
            .setDescription('Posts a random image from the Homies channel')
            .addStringOption((option=>option.setName("message").setDescription("Add a little flavor to your homie roll.")))
            .addStringOption((option=>option.setName("user").setDescription("Tag a user to get their uploads"))),
        execute: defaultExecute
    }
}
export default Object.values(commands)