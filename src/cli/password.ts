// Set the web UI login:  npm run password -- [username]   (prompts for the password; logs out all sessions)
// In the container:      docker exec -it los npm run password -- toffe
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { writeAuthFile } from "../web/auth.js";

const root = process.env.LOS_ROOT ?? process.cwd();
const username = process.argv[2] ?? "toffe";
let password = process.env.LOS_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = (await rl.question(`New password for ${username}: `)).trim();
  rl.close();
}
if (password.length < 10) throw new Error("use at least 10 characters");
mkdirSync(join(root, "data"), { recursive: true });
writeAuthFile(join(root, "data/auth.json"), username, password);
console.log(`saved data/auth.json for "${username}"; existing sessions are logged out`);
