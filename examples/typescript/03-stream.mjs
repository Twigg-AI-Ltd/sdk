// Stream a reply, printing text as it arrives, then read the final result.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Stream example" });

const reply = await chat
  .stream("Explain what a hash table is in one paragraph.")
  .on("text", (delta) => process.stdout.write(delta))
  .finalResponse();

console.log("\n\nstop reason:", reply.stopReason, "cost:", reply.cost);
