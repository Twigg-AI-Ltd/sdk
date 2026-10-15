// Pick up the most recent chat and carry the conversation on.
// Nothing is stored locally: Twigg holds the history, so a chat id is all you need.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });

const page = await twigg.chats.list({ namespace: "examples", limit: 1 });
const latest = page.data[0];
if (!latest) throw new Error("No chats yet; run 02-send.mjs first");

const chat = twigg.chat(latest);
const reply = await chat.send("Summarise what we've talked about so far in one sentence.");
console.log(reply.text);
