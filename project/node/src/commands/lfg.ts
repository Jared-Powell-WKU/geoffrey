import { SlashCommandBuilder, ButtonBuilder, ActionRowBuilder, EmbedBuilder, MessageFlags, ChatInputCommandInteraction } from 'discord.js'
const phrases = require('../util/lfgphrases')
const commands = {
    lfg: {
        data: new SlashCommandBuilder()
            .setName('lfg')
            .setDescription('Search for a group by role and # of players')
            .addIntegerOption((option=>option.setName("slots").setDescription("Max # of players to join up").setRequired(true)))
            .addRoleOption((option=>option.setName("role").setDescription("The role to ping for this request")))
            .addStringOption((option=>option.setName("message").setDescription("Additional message (please specify game if no role was mentioned)"))),
        async execute(interaction: ChatInputCommandInteraction) {
            try {
                const numPlayers = interaction.options.getInteger("slots")
                const message = interaction.options.getString("message") || false;
                const rolePinged = interaction.options.getRole("role") || false;
                let usersList: Array<[string, string]> = []
                const removeFromCall = new ButtonBuilder()
                    .setCustomId('remove')
                    .setLabel('-')
                    .setStyle(2);
                const addToCall = new ButtonBuilder()
                    .setCustomId('add')
                    .setLabel('+')
                    .setStyle(1);

                const createEmbed = () => {
                    return new EmbedBuilder()
                    .setTitle("LFG")
                    .setColor("Blue")
                    .setDescription("Click the + to ready up!")
                    .addFields(
                        { name: `Users (${usersList.length}/${numPlayers})`, value:usersList.length > 0 ? usersList.map((u)=>{return u[0]}).join(', ') : "N/A"}
                    )
                }
                
                const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(removeFromCall, addToCall)
                const response = await interaction.reply({
                    content:`${rolePinged || ""}${(rolePinged && message) ? "\n" : ""}${message || ""}`,
                    embeds: [createEmbed()],
                    components: [buttonRow]
                });
                const collector = response.createMessageComponentCollector({ time:3600000 })
                collector.on('collect', async (confirmation)=>{
                    const user = confirmation.user.username
                    if(confirmation.customId == "add") {
                        if(usersList.filter((u)=>{ return u[0] === user}).length) {
                            confirmation.reply({content:"You are already readied up!", flags: MessageFlags.Ephemeral})
                            return;
                        } else {
                            usersList.push([user, confirmation.user.id]);
                        }
                    } else if(confirmation.customId == "remove") {
                        if(!usersList.map((u)=>{return u[0]}).includes(user)) {
                            confirmation.reply({content:"You are not currently in the queue!", flags: MessageFlags.Ephemeral})
                            return;
                        } else {
                            usersList = usersList.filter((u) =>{return u[0] !== user});
                        }
                    }
                    if(usersList.length == numPlayers && interaction.channel?.isTextBased() && 'send' in interaction.channel) {
                        interaction.channel.send(`${phrases[Math.floor(Math.random() * phrases.length)]}\n${usersList.map((u) => `<@${u[1]}>`).join(' ')}`)
                    }
                    confirmation.update({
                        embeds: [createEmbed()],
                        components:[buttonRow]
                    })
                })
                collector.on('end', async()=>{
                    response.edit({content:"This LFG call has expired", embeds:[], components:[]});
                })
                                
            } catch(e) {
                console.error(`lfg error at ${new Date().toLocaleDateString('en-us', { weekday:"long", year:"numeric", month:"short", day:"numeric"})}:`, e);
            }
        }
    }
}
export default Object.values(commands);