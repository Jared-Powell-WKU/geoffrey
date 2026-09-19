import { ApplicationCommand, REST, Routes } from 'discord.js'
require('dotenv').config();
import * as fs from 'node:fs';
import { DiscordCommand } from './util/commandHelper';
import { exit } from 'node:process';

const commands = [];
const commandsClantus = [];
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
const commandFilesClantus = fs.readdirSync('./commands-clantus').filter(file => file.endsWith('.js'));

// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
	let command = require(`./commands/${file}`);
	try {
		if(command?.default) command = command.default;
		if(command.length) command.forEach((c: DiscordCommand) => {
			commands.push(c.data.toJSON());
		});
		else commands.push(command.data.toJSON());
	} catch(e) {
		console.error(file, e);
	}
}

for (const file of commandFilesClantus) {
	let command = require(`./commands-clantus/${file}`);
	try {
		if(command?.default) command = command.default;
		if(command.length) command.forEach((c: DiscordCommand) => {
			commandsClantus.push(c.data.toJSON());
		});
		else commandsClantus.push(command.data.toJSON());
	} catch(e) {
		console.error(file, e);	
	}
}

// Construct and prepare an instance of the REST module
const {CLIENT_ID, CLIENT_TOKEN, GUILDS, TEST_INSTANCE} = process.env;

if(!(CLIENT_ID && CLIENT_TOKEN && GUILDS && TEST_INSTANCE)) {
	throw 'Missing required environment variables';
}
const rest = new REST({ version: '10' }).setToken(CLIENT_TOKEN);
const guilds = JSON.parse(GUILDS);
const guildIds = Object.values(guilds).map((e: any)=>{return e.guildId});
(async () => {
	for(var guild of guildIds) {
		if(TEST_INSTANCE == "test" && guild == guilds.tncord.guildId) continue;
			try {
				console.info(`Started refreshing ${commands.length} application (/) commands.`);
				const data = await rest.put(
					Routes.applicationGuildCommands(CLIENT_ID, guild),
					{ body: (guild == guilds.clantus.guildId ? commands.concat(commandsClantus) : commands) },
				) as ApplicationCommand[];
				console.log(`Succesfully updated ${data.length} command(s).`);
			} catch (error) {
				console.error(error);
			}
	}
})().then(() => {
	exit();
});