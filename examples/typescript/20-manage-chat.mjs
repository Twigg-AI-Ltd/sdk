// Rename a chat and change its metadata, and keep your own data beside a message with
// client_data: stored with the part, never sent to the model, and read back from history.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({
  namespace: "examples",
  title: "Untitled",
  user_metadata: { channel: "web", trial: true },
});

await chat.send({ type: "prompt", text: "I'd like a refund.", client_data: { messageId: "m-1" } });

// Fields left out are unchanged; a metadata key sent as null is removed.
const updated = await chat.update({ title: "Refund request", user_metadata: { trial: null, tier: "gold" } });
console.log(updated.title, updated.user_metadata); // Refund request { channel: 'web', tier: 'gold' }

const page = await chat.history({ after_ordinal: -1, include_client_data: true });
for (const part of page.data) console.log(part.role, part.part.type, part.client_data ?? "");
await chat.delete();
