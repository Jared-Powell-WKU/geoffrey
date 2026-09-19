import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { DiscordCommand } from '../util/commandHelper';
import { getPokemonStats } from '../util/pokemon';
const commands: Record<string, DiscordCommand> = {
    pokestats: {
        data: new SlashCommandBuilder()
            .setName('pokestats')
            .setDescription('Returns end of match stats for Showdown replays')
            .addStringOption((option=>option.setName("url").setDescription("URL to the replay file.").setRequired(true))),
        async execute(interaction: ChatInputCommandInteraction) {
            try {
                const replayObj = await getPokemonStats(interaction.options.getString("url"));
                if(replayObj.participants) {
                    const embed = new EmbedBuilder()
                        .setTitle(`${replayObj.participants[0]?.trainer} vs. ${replayObj.participants[1]?.trainer} (Results)`)
                        .setColor("Blue")
                        .setDescription(`Winner: **${replayObj.winner}**`)
                        .addFields(
                            { name: `${replayObj.participants[0]?.trainer}`, value:(replayObj.participants[0] ? replayObj.participants[0].getPokemonTeamAsString() : "")},
                            { name: `${replayObj.participants[1]?.trainer}`, value:(replayObj.participants[1] ? replayObj.participants[1].getPokemonTeamAsString() : "")}
                        )
                    interaction.reply({content:"Here you go!", flags: MessageFlags.Ephemeral, embeds:[embed]});
                } else {
                    interaction.reply({content:"Unable to parse replay", flags: MessageFlags.Ephemeral});
                }
            } catch(e) {
                console.error(`Pokestat error at ${new Date().toLocaleDateString('en-us', { weekday:"long", year:"numeric", month:"short", day:"numeric"})}:`, e);
                interaction.reply({content:"There was a problem parsing the replay. Please try again or contact Cantus with replay file.", flags: MessageFlags.Ephemeral})
            }
        }
    }
}

export default Object.values(commands)