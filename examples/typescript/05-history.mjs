// Print the transcript of the most recent chat in the namespace, oldest first.
// `after_ordinal: -1` pages forwards from the start; without it history runs newest first.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg();

const page = await twigg.chats.list({ namespace: "examples", limit: 1 });
const latest = page.data[0];
if (!latest) throw new Error("No chats yet; run 02-send.mjs first");

console.log(`# ${latest.title ?? latest.id}\n`);
for await (const item of twigg.chat(latest).history({ after_ordinal: -1 })) {
  const { part } = item;
  const text = "text" in part ? part.text : JSON.stringify(part);
  console.log(`[${item.ordinal}] ${part.type}: ${text}`);
}
