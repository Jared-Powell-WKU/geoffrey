import { writeFileSync } from "node:fs";
import { Client } from "discord.js";

// The container healthcheck reads this file and fails when it is stale, so a
// bot that has lost its gateway connection is reported unhealthy.
const HEALTH_FILE = process.env.HEALTH_FILE || "/tmp/geoffrey-health";
const HEARTBEAT_MS = 30_000;

export function startHealthHeartbeat(client: Client) {
    const beat = () => {
        if(!client.isReady()) return;
        try {
            writeFileSync(HEALTH_FILE, String(Date.now()));
        } catch(e) {
            console.error("Unable to write health file:", e);
        }
    }
    beat();
    setInterval(beat, HEARTBEAT_MS);
}
