// What failures look like: every error is a TwiggError with status, code, message and hint,
// and subclasses let you catch by kind.
import { NotFoundError, Twigg, TwiggError } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });

try {
  await twigg.chats.get("00000000-0000-0000-0000-000000000000");
} catch (err) {
  if (err instanceof NotFoundError) console.log("not found:", err.message);
  else throw err;
}

try {
  const chat = await twigg.chats.open({ namespace: "examples" });
  await chat.send("Hi", { model: "no-such-model" });
} catch (err) {
  if (!(err instanceof TwiggError)) throw err;
  console.log(err.constructor.name, { status: err.status, code: err.code, message: err.message, hint: err.hint });
}
