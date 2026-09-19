// Kept free of side effects (no pool, no dotenv) so it can be imported by the
// internal API and its tests without opening database connections.
enum Tables {
    homies = "homies",
    cute = "pets",
    pets = "pets"
}

export function getTableByCommandName(commandName: string): string|undefined {
    if(Object.prototype.hasOwnProperty.call(Tables, commandName)) {
        return Tables[commandName as keyof typeof Tables]
    }
}
