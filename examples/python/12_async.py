# The async client: same methods, awaited. Here two chats stream at the same time.
import asyncio

from twigg import AsyncTwigg


async def ask(twigg: AsyncTwigg, question: str) -> None:
    chat = await twigg.chats.open(namespace="examples", title="Async example")
    reply = await chat.send(question)
    print(f"{question}\n  -> {reply.text}\n")


async def main() -> None:
    async with AsyncTwigg(model="gpt-6-luna") as twigg:
        await asyncio.gather(
            ask(twigg, "What is 17 * 23?"),
            ask(twigg, "Name a famous bridge."),
        )


asyncio.run(main())
