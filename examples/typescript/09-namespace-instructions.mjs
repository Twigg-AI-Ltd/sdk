// Scope a client to one namespace, publish system instructions there, chat under them,
// then withdraw the instructions again so the namespace is back as it was.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const scope = twigg.namespace("examples").child("pirate"); // examples/pirate

await scope.config.instructions.publish({ mode: "append", body: "Always answer like a pirate." });
try {
  const chat = await scope.chats.open({ title: "Instructions example" });
  const reply = await chat.send("What's the capital of France?");
  console.log(reply.text);
} finally {
  await scope.config.instructions.withdraw();
}
