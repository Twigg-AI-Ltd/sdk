// Start a long reply and stop it once ~300 characters of text have arrived. abort() stops the turn on Twigg,
// not just this connection, and the stream ends with stop reason "aborted".
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Abort example" });

const stream = chat.stream("Write a 2000 word essay on the history of bread.");
stream.on("text", (delta, text) => {
  process.stdout.write(delta);
  if (text.length > 300) stream.abort();
});

const result = await stream.final();
console.log("\n\nstop reason:", result.stopReason, "cost:", result.cost);
