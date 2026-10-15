// Forwarding a stream to a browser without exposing the API key. On a server,
// `stream.toResponse()` is what a route handler returns; in the browser,
// readForwardedStream() parses it. Here both halves run in one script for clarity.
// Only content is forwarded by default: cost and config warnings stay on the server.
import { Twigg } from "@twigg/sdk";
import { readForwardedStream } from "@twigg/sdk/browser";

// --- server: e.g. a Next.js POST handler would `return` this Response
const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Forwarding" });
const response = chat.stream("Count from one to five in words.").toResponse();

// --- browser: `response` would come from fetch("/api/chat", ...)
const turn = readForwardedStream(response);
turn.on("text", (delta) => process.stdout.write(delta));
const result = await turn.final();
console.log("\n\nstop reason:", result.stopReason, "cost (withheld from browsers):", result.cost);
