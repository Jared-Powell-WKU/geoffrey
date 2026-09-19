import { SlashCommandOptionsOnlyBuilder, CommandInteraction } from 'discord.js';

export interface DiscordCommand {
    data: SlashCommandOptionsOnlyBuilder;
    execute(interaction: CommandInteraction): Promise <void>;
}
