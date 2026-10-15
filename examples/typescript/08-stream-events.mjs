// Iterate a stream's raw events instead of using listeners: run, block_start, delta,
// block_stop, done and friends. Useful when forwarding to a UI or debugging.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Events example" });

const stream = chat.stream("Say hello in three languages.");
for await (const event of stream) {
  if (event.event === "delta") console.log("delta", event.data.kind, JSON.stringify(event.data.text));
  else console.log(event.event, JSON.stringify(event.data));
}

const result = await stream.final();
console.log("\nblocks:", result.blocks.length, "text:", result.text);
