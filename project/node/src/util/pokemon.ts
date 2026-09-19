interface Pokemon {
    species: string;
    nickname: string;
    alive: boolean;
    bodyCount: number;
}
interface ShowdownJson {
    log: string;
    players: [string, string]
}
type PokemonTeam = {
    [key: string]: Pokemon
}
interface MatchResults {
    winner: string|null;
    participants: [PokemonTeamManager|null, PokemonTeamManager|null]
}
class PokemonTeamManager {
    trainer: string;
    trainerIndex: number;
    pokemon: PokemonTeam
    constructor(player: string, trainerIndex: number) {
        this.trainer = player;
        this.trainerIndex = trainerIndex;
        this.pokemon = {}
    }
    isFullTeam(): boolean {
        return Object.keys(this.pokemon).length == 6;
    }
    addPokemon(pokemon: Pokemon): boolean {
        if(this.isFullTeam()) {
            throw `Tried adding pokemon ${pokemon.species}, but the team is already full!`;
        }
        if(this.pokemon[pokemon.nickname] ?? false) {
            throw `Pokemon ${pokemon.nickname} already exists`
        }
        this.pokemon[pokemon.nickname] = pokemon;
        return true;
    }
    hasPokemon(nickname: string): boolean {
        return (this.pokemon[nickname] ? true : false);
    }
    getPokemon(nickname: string): Pokemon|false {
        return this.pokemon[nickname] || false;
    }
    getPokemonTeamAsString(): string {
        let outString: string = ""
        Object.values(this.pokemon).forEach((pokemon: Pokemon)=>{
            outString += `${pokemon.nickname} **(${pokemon.species})**\n**KOs**: ${pokemon.bodyCount} **Status**: ${pokemon.alive ? "Alive" : "RIP"}\n`
        })
        return outString;
    }
}
class Replay {
        log: string[];
        players: [string, string];
        participants: [PokemonTeamManager, PokemonTeamManager]
    constructor(showdownJson: ShowdownJson){
        this.log = showdownJson.log.split('\n');
        this.players = showdownJson.players
        this.participants = [new PokemonTeamManager(this.players[0], 0), new PokemonTeamManager(this.players[1], 1)];
    }
    getMatchResults(): MatchResults {
        const pokemonTeams = this.participants
        const activePokemon: [string, string] = ["", ""]

        this.log.forEach((entry: string)=>{
            const switchRegex = new RegExp(/\|(?:switch|drag)\|\w(\d)\w: ([^\|]+)\|([^\|,]+).*\|.*/)
            if(switchRegex.test(entry)) {
                const regexResult: RegExpExecArray|null = switchRegex.exec(entry);
                /**
                 * 0: line
                 * 1: player#
                 * 2: Pokemon Nickname
                 * 3: Pokemon Species
                 */
                const playerIndex: number = (Number.parseInt(regexResult?.[1] ?? "0")-1);
                const pokemonNickname: string = regexResult?.[2] ?? "";
                const pokemonSpecies: string = regexResult?.[3] ?? "";
                if(playerIndex == -1 || !pokemonNickname || !pokemonSpecies) {
                    const errorData = JSON.stringify({playerIndex, pokemonNickname, pokemonSpecies, entry:entry})
                    throw "There was a problem getting replay information "+errorData
                }
                if(!pokemonTeams[playerIndex].hasPokemon(pokemonNickname)) {
                    pokemonTeams[playerIndex].addPokemon({species:pokemonSpecies, nickname:pokemonNickname, alive:true, bodyCount:0})
                }
                activePokemon[playerIndex] = pokemonNickname;
                return;
            }
            const faintRegex = new RegExp(/\|faint\|\w(\d)\w: (.*)/);
            if(faintRegex.test(entry)) {
                /**
                 * 0: line
                 * 1: player#
                 * 2: Pokemon Nickname
                 */
                const regexResult = faintRegex.exec(entry);
                const playerIndex: number = (Number.parseInt(regexResult?.[1] ?? "0")-1);
                const pokemonNickname: string|undefined = regexResult?.[2];
                if(playerIndex == -1 || !pokemonNickname) {
                    const errorData = JSON.stringify({playerIndex, pokemonNickname, "entry":entry, team:pokemonTeams[playerIndex]})
                    throw "There was a problem getting replay information "+errorData
                }

                const downedPokemon = pokemonTeams[playerIndex].getPokemon(pokemonNickname);
                if(!downedPokemon) {
                    throw `There was a problem with pokemon ${pokemonNickname}`
                }
                downedPokemon.alive = false;
                const koingPlayer = playerIndex == 0 ? 1 : 0;
                const koingPokemon = pokemonTeams[koingPlayer].getPokemon(activePokemon[koingPlayer])
                if(!koingPokemon) {
                    throw `There was a problem getting ${this.players[koingPlayer]}'s active Pokemon`;
                }
                koingPokemon.bodyCount++;
            }
            const forfeitRegex = new RegExp(/^\|\-message\|(.*) forfeited\.$/)
            if(forfeitRegex.test(entry)) {
                const quitter: string|undefined = forfeitRegex.exec(entry)?.[1];
                if(!quitter) {
                    console.warn("forfeitRegex tested true but exec'd as false");
                }
                if(quitter) {
                    const quittingTeam = pokemonTeams.filter((pokemonTeam: PokemonTeamManager)=> {
                        return pokemonTeam.trainer == quitter
                    })[0]
                    const winningPlayerIndex = quittingTeam.trainerIndex == 0 ? 1 : 0;
                    Object.values(quittingTeam.pokemon).forEach((quittingTeamPokemon)=> {
                        const koingPokemon = pokemonTeams[winningPlayerIndex].getPokemon(activePokemon[winningPlayerIndex])
                        if(quittingTeamPokemon.alive) {
                            quittingTeamPokemon.alive = false;
                            if(koingPokemon) koingPokemon.bodyCount++;                    
                        }
                    })
                }
            }
        })
        return {winner:this.getMatchWinner(), participants: [pokemonTeams[0], pokemonTeams[1]]};
    }
    getMatchWinner(): string {
        const stillAlive = this.participants.filter((pokemonTeamManager)=>{
            if(!pokemonTeamManager) return false;
            return Object.values(pokemonTeamManager.pokemon).filter((pokemon)=>{return pokemon.alive}).length > 0
        });
        if(stillAlive == null || !stillAlive?.[0] || stillAlive.length != 1) {
            const winnerRegex = new RegExp(/^\|win\|(.*)$/)
            const filteredLog = this.log.filter((logEntry: string)=>{
                return winnerRegex.test(logEntry)
            });
            if(!filteredLog.length) {
                throw 'The winner cannot be decided';
            }
            const winner = winnerRegex.exec(filteredLog[0])?.[1];
            if(!winner) {
                throw "The winner cannot be decided."
            }
            return winner;
        }
        return stillAlive[0]?.trainer;
    }
}
async function getShowdownJson(url: string) : Promise<Replay> {
    try {
        const response = await fetch(url);
        if(!response.ok) {
            throw new Error(`Error getting Showdown data: ${response.status}`)
        }
        const data: ShowdownJson = await response.json();
        return new Replay(data)
    } catch (e) {
        console.error("Error fetching Showdown Replay:", e);
        throw e;
    }
}

export async function getPokemonStats(suppliedPath: string|null): Promise<MatchResults> {
    if(!suppliedPath) throw "No url provided!";
    if(!suppliedPath.endsWith(".json")) {
        const replayRegex = new RegExp(/replay\.pokemonshowdown\.com\/([^\/]+)/);
        if(!replayRegex.test(suppliedPath)) {
            throw 'Unable to get replay path. Please ensure that the url is correct.'
        }
        const regexResult = replayRegex.exec(suppliedPath);
        if(regexResult?.[1]) suppliedPath = "https://replay.pokemonshowdown.com/"+regexResult[1]+".json";
    }
    const replay = await getShowdownJson(suppliedPath);
    try {
        return replay.getMatchResults();
    } catch(e) {
        console.error("Error getting Match Results", e);
        throw e;
    }
}