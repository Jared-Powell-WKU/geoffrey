import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, GuildMemberRoleManager } from 'discord.js'
import { checkEvPortStatus } from '../util/checkEvPortStatus';

const commands = {
    "ev-subscribe": {
        data: new SlashCommandBuilder()
            .setName("ev-subscribe")
            .setDescription("Subscribe to EV charging port notifications."),
        async execute(interaction: ChatInputCommandInteraction) {
            const role = interaction.guild?.roles.cache.find(r => r.name === 'ev-notifications');
            if (!role) {
                return interaction.reply({ content: "Role 'ev-notifications' not found.", flags: MessageFlags.Ephemeral });
            }
            const userRoles = (interaction.member?.roles as GuildMemberRoleManager | undefined);
            if (!userRoles) {
                return interaction.reply({ content: "Unable to manage roles for this user.", flags: MessageFlags.Ephemeral });
            }
            await userRoles.add(role);
            await interaction.reply({ content: `You have been subscribed to EV charging port notifications.`, flags: MessageFlags.Ephemeral });
        }
    },
    "ev-unsubscribe": {
        data: new SlashCommandBuilder()
            .setName("ev-unsubscribe")
            .setDescription("Unsubscribe from EV charging port notifications."),
        async execute(interaction: ChatInputCommandInteraction) {
            const role = interaction.guild?.roles.cache.find(r => r.name === 'ev-notifications');
            if (!role) {
                return interaction.reply({ content: "Role 'ev-notifications' not found.", flags: MessageFlags.Ephemeral });
            }
            const userRoles = (interaction.member?.roles as GuildMemberRoleManager | undefined);
            if (!userRoles) {
                return interaction.reply({ content: "Unable to manage roles for this user.", flags: MessageFlags.Ephemeral });
            }
            await userRoles.remove(role);
            await interaction.reply({ content: `You have been unsubscribed from EV charging port notifications.`, flags: MessageFlags.Ephemeral });
        }
    },
    "ev-status": {
        data: new SlashCommandBuilder()
            .setName("ev-status")
            .setDescription("Get the current status of EV charging ports in the Clantus server."),
        async execute(interaction: ChatInputCommandInteraction) {
            await interaction.deferReply({ ephemeral: true });
            const status = await checkEvPortStatus();
            const responseMessage = `EV Port Status: ${status ? 'Available' : 'Not Available'} (checked at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })})`;
            await interaction.editReply({ content: responseMessage });
        }
    }
}

export default Object.values(commands);