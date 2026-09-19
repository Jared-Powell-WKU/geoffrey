import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, PermissionsBitField, EmbedBuilder, APIEmbedField, RestOrArray } from 'discord.js'
import { DiscordCommand } from '../util/commandHelper';
import { executeQuery, fetchUser, getSupportedGuildByGuildId, getTableByCommandName, GuildDictionary } from '../util/util';

const commands: Record<string, DiscordCommand> = {
    stats: {
        data: new SlashCommandBuilder()
            .setName("stats")
            .setDescription("Retrieve personal Geoffrey stats"),
        async execute(interaction: ChatInputCommandInteraction) {
            const { guildId, member, client } = interaction;
            const userId = member?.user.id;
            if (!guildId) {
                interaction.reply({ content: "Unable to parse guildId", flags: MessageFlags.Ephemeral });
                return;
            }
            const activeGuild = await getSupportedGuildByGuildId(guildId);
            if (!activeGuild?.guildId) {
                interaction.reply({ content: "This is not a supported guild", flags: MessageFlags.Ephemeral });
            }
            if (!userId) {
                interaction.reply({ content: "Unable to get user information", flags: MessageFlags.Ephemeral });
                return;
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            const tables = Object.keys(activeGuild.channels);
            const embedFields: RestOrArray<APIEmbedField> = [];
            (async () => {

                for (const table of tables) {
                    const records = await getStatsRecordSetByTable(getTableByCommandName(table), guildId);
                    const userPosition = records.findIndex(element => element?.userId == userId);
                    if (userPosition === null) continue;
                    const leaderboardText = await buildLeaderboard(records.slice(Math.max(userPosition - 4, 0), Math.max(userPosition - 4, 0) + 9), client, userId, Math.max(userPosition-4, 0));
                    if (leaderboardText) {
                        const tableName = table.charAt(0).toUpperCase() + table.slice(1);
                        embedFields.push({ name: tableName, value: leaderboardText });
                    }
                }
            })().then(async () => {
                if (embedFields.length) {
                    const embed = new EmbedBuilder()
                        .setTitle("Stats")
                        .setColor("Blue")
                        .addFields(
                            ...embedFields
                        )
                    await interaction.editReply({ embeds: [embed] })
                } else {
                    await interaction.editReply({ content: "No submissions found." })
                }
            })
        }
    },
    leaderboard: {
        data: new SlashCommandBuilder()
            .setName("leaderboard")
            .setDescription("Displays highest contributing users to Geoffrey, by guild")
            .addStringOption(option =>
                option.setName('category')
                    .setDescription("[OPTIONAL] If specified, only data regarding the selected table will be displayed.")
                    .addChoices(
                        { name: "Homies", value: "homies" },
                        { name: "Cute", value: "cute" }
                    )
            ),
        async execute(interaction: ChatInputCommandInteraction) {
            const { guildId, client, user } = interaction;
            const table = interaction.options.getString("category");
            const embedFields: RestOrArray<APIEmbedField> = [];
            await interaction.deferReply({ flags: MessageFlags.Ephemeral })
            const potentialTables = ["homies", "cute"];
            (async () => {
                for (const potentialTableName of potentialTables) {
                    if (!table || table == potentialTableName) {
                        const tableName = getTableByCommandName(potentialTableName);
                        if (!tableName) return;
                        const records = await getStatsRecordSetByTable(tableName, guildId);
                        const leaderboardText = await buildLeaderboard(records, client, user.id)
                        if (leaderboardText) {
                            const tableDisplayName = potentialTableName.charAt(0).toUpperCase() + potentialTableName.slice(1);
                            embedFields.push({ name: tableDisplayName, value: leaderboardText })
                        }
                    }
                }
            })().then(async () => {
                if (embedFields.length) {
                    const embed = new EmbedBuilder()
                        .setTitle("Leaderboard")
                        .setColor("Blue")
                        .addFields(
                            ...embedFields
                        )
                    await interaction.editReply({ embeds: [embed] })
                } else {
                    await interaction.editReply({ content: "No submissions found." })
                }
            })
        }
    }
}

async function getStatsRecordSetByTable(tableName: string | undefined, guildId: string | null): Promise<[Record<string, any>] | []> {
    if (!tableName) return [];
    return await executeQuery(`SELECT userId, count(*) AS \`count\` FROM ${tableName} WHERE guildId = ? AND userId IS NOT NULL GROUP BY userId ORDER BY count(*) DESC;`, [guildId]);
}

async function buildLeaderboard(orderedData: Record<string, any>[], client: any, userId: string, startingIndex: number = 0, leaderboardLength: number = 10) {
    let leaderboardText = "";
    for (let i = 0; i < orderedData.length && i < leaderboardLength; i++) {
        const r = orderedData[i];
        try {
            const leaderboardUser = await fetchUser(r?.userId, client);
            const formattedUserName = userId === leaderboardUser.id ? `${leaderboardUser.globalName} (You)` : leaderboardUser.globalName;
            leaderboardText += `${startingIndex+1+i}. **${formattedUserName}** (${parseInt(r.count)})\n`;
        } catch (e) {
            console.error("There was a problem fetching User", r?.userId)
            console.error("Error message:", e);
        }
    }
    return leaderboardText;
}
export default Object.values(commands)