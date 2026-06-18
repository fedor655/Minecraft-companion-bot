# ============================================================
#  МОЗГ БОТА (Python)
#  Подключается по WebSocket к "телу" (Mineflayer), слушает
#  события (чат, здоровье) и шлёт боту команды.
#
#  Пока это простой мозг на правилах: понимает ключевые слова
#  из чата. Это фундамент — позже сюда подключим LLM (Claude),
#  чтобы бот стал по-настоящему умным.
# ============================================================

import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:
    print("Не установлена библиотека websockets.")
    print("Установи зависимости:  pip install -r requirements.txt")
    sys.exit(1)

BRIDGE_URL = os.environ.get("BRIDGE_URL", "ws://localhost:3000")
BOT_NAME = os.environ.get("BOT_NAME", "Druzhok")  # должно совпадать с username в bot/config.json

_msg_id = 0


async def send_command(ws, name, **args):
    """Отправить телу команду на выполнение."""
    global _msg_id
    _msg_id += 1
    await ws.send(json.dumps({"type": "command", "id": str(_msg_id), "name": name, "args": args}))
    print(f"[мозг -> бот] {name} {args if args else ''}")


def decide(username, text):
    """
    Простой мозг на правилах. По тексту из чата возвращает
    список действий: [(имя_команды, аргументы), ...].
    Здесь же потом подключим LLM для умных решений.
    """
    t = text.lower().strip()
    actions = []

    if any(k in t for k in ["ко мне", "иди сюда", "подойди", "come"]):
        actions.append(("come", {"player": username}))
        actions.append(("chat", {"text": f"Иду к тебе, {username}!"}))

    elif any(k in t for k in ["за мной", "следуй", "следи за мной", "иди со мной", "follow"]):
        actions.append(("follow", {"player": username}))
        actions.append(("chat", {"text": "Окей, иду за тобой!"}))

    elif any(k in t for k in ["стоп", "стой", "хватит", "stop"]):
        actions.append(("stop", {}))
        actions.append(("chat", {"text": "Остановился."}))

    elif any(k in t for k in ["где ты", "статус", "status"]):
        actions.append(("status", {}))

    elif any(k in t for k in ["прыг", "jump"]):
        actions.append(("jump", {}))
        actions.append(("chat", {"text": "Оп!"}))

    elif any(k in t for k in ["осмотрись", "что вокруг", "look"]):
        actions.append(("lookAround", {}))

    elif any(k in t for k in ["привет", "хай", "hello", "hi", "прив"]):
        actions.append(("chat", {
            "text": f"Привет, {username}! Команды: «ко мне», «за мной», «стоп», «где ты», «прыгни», «что вокруг»."
        }))

    return actions


async def handle(ws, msg):
    mtype = msg.get("type")

    if mtype == "event":
        ev = msg.get("event")
        data = msg.get("data", {})

        if ev == "ready":
            print(f"[событие] Бот зашёл в игру: {data}")
            await send_command(ws, "chat", text="Привет! Я в игре. Напиши «привет», чтобы увидеть команды.")

        elif ev == "chat":
            username = data.get("username")
            text = data.get("message", "")
            if username == BOT_NAME:
                return
            print(f"[чат] <{username}> {text}")
            for name, args in decide(username, text):
                await send_command(ws, name, **args)

        elif ev == "death":
            print("[событие] Бот умер.")

    elif mtype == "result":
        if not msg.get("ok"):
            print(f"[бот вернул ошибку] {msg.get('error')}")
            # подскажем в чате, если кого-то не нашли
            err = msg.get("error", "")
            if "Не вижу игрока" in err:
                await send_command(ws, "chat", text="Я тебя не вижу рядом — подойди поближе.")
        else:
            data = msg.get("data", {})
            # ответ команды status — расскажем в чате
            if "health" in data and "position" in data:
                p = data["position"]
                await send_command(
                    ws, "chat",
                    text=f"HP {data['health']}/20, еда {data['food']}/20, координаты x{p['x']} y{p['y']} z{p['z']}"
                )
            # ответ lookAround — что видно вокруг
            elif "nearby" in data:
                names = ", ".join(e.get("name", "?") for e in data["nearby"][:6]) or "никого"
                await send_command(ws, "chat", text=f"Вокруг вижу: {names}")


async def main():
    print(f"[мозг] Подключаюсь к мосту {BRIDGE_URL} ...")
    while True:
        try:
            async with websockets.connect(BRIDGE_URL) as ws:
                print("[мозг] Подключился к телу бота. Слушаю чат в игре...")
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    await handle(ws, msg)
        except (OSError, ConnectionError) as e:
            print(f"[мозг] Нет связи с мостом ({e}). Повтор через 3с... (запущен ли bot/index.js?)")
            await asyncio.sleep(3)
        except Exception as e:
            print(f"[мозг] Соединение закрылось ({e}). Повтор через 3с...")
            await asyncio.sleep(3)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[мозг] Выключаюсь. Пока!")
