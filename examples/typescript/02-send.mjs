// Open a new chat and send one message, waiting for the whole reply.
// Prints the text, what it cost, and the token usage.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });

const chat = await twigg.chats.open({ namespace: "examples", title: "Send example" });
const reply = await chat.send("Give me three names for a pet hedgehog.");

console.log(reply.text);
console.log("\ncost:", reply.cost, reply.costCurrency);
console.log("usage:", reply.usage);
console.log("chat:", chat.id);
