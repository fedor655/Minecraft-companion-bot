'use strict'

// ============================================================
//  ТЕЛО БОТА
//  Mineflayer подключается к миру Minecraft (глаза, руки, ноги),
//  а WebSocket-мост связывает его с Python-мозгом.
//  Python шлёт команды ("иди к игроку"), бот выполняет
//  и отправляет обратно события (чат, здоровье, позиция).
// ============================================================

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { WebSocketServer } = require('ws')

// ---------- Конфиг ----------
const configPath = path.join(__dirname, 'config.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

// Переопределения из командной строки:
//   node index.js --port 54321 --host localhost
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--host') config.host = argv[++i]
  else if (argv[i] === '--port') config.port = parseInt(argv[++i], 10)
  else if (argv[i] === '--username') config.username = argv[++i]
  else if (argv[i] === '--bridge-port') config.bridgePort = parseInt(argv[++i], 10)
}

const VERSION = (!config.version || config.version === 'auto') ? false : config.version

// ---------- Мост WebSocket ----------
const wss = new WebSocketServer({ port: config.bridgePort })
const clients = new Set()

function broadcast (obj) {
  const data = JSON.stringify(obj)
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data)
  }
}

function sendEvent (event, data = {}) {
  broadcast({ type: 'event', event, data })
}

wss.on('connection', (ws) => {
  clients.add(ws)
  console.log('[мост] Python-мозг подключился. Всего:', clients.size)
  if (bot && bot.entity) sendEvent('state', getState())

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type !== 'command') return

    const handler = commands[msg.name]
    if (!handler) {
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: `Неизвестная команда: ${msg.name}` }))
      return
    }
    if (!bot || !bot.entity) {
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'Бот ещё не в игре' }))
      return
    }
    try {
      const result = await handler(msg.args || {})
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data: result || {} }))
    } catch (err) {
      ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: String(err.message || err) }))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log('[мост] Python-мозг отключился. Осталось:', clients.size)
  })
})

console.log(`[мост] WebSocket-сервер слушает ws://localhost:${config.bridgePort}`)

// ---------- Состояние ----------
function round (n) { return Math.round(n * 100) / 100 }

function getState () {
  if (!bot || !bot.entity) return {}
  const p = bot.entity.position
  return {
    username: bot.username,
    health: bot.health,
    food: bot.food,
    position: { x: round(p.x), y: round(p.y), z: round(p.z) },
    dimension: bot.game && bot.game.dimension,
    timeOfDay: bot.time && bot.time.timeOfDay,
    players: Object.keys(bot.players).filter((n) => n !== bot.username)
  }
}

// ---------- Команды (то, что умеет тело) ----------
// Каждая команда — функция, которую вызывает мозг. Сюда легко
// добавлять новые навыки: копать, крафтить, драться и т.д.
let bot = null
let defaultMove = null

const commands = {
  async chat ({ text }) {
    bot.chat(String(text))
    return { said: text }
  },

  async come ({ player }) {
    const target = bot.players[player] && bot.players[player].entity
    if (!target) throw new Error(`Не вижу игрока «${player}» рядом`)
    const { x, y, z } = target.position
    bot.pathfinder.setMovements(defaultMove)
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2))
    return { goingTo: player }
  },

  async follow ({ player }) {
    const target = bot.players[player] && bot.players[player].entity
    if (!target) throw new Error(`Не вижу игрока «${player}» рядом`)
    bot.pathfinder.setMovements(defaultMove)
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true) // true = динамическая цель
    return { following: player }
  },

  async stop () {
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    return { stopped: true }
  },

  async jump () {
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 300)
    return { jumped: true }
  },

  async status () {
    return getState()
  },

  async lookAround () {
    const me = bot.entity.position
    const nearby = Object.values(bot.entities)
      .filter((e) => e.position && e !== bot.entity && e.position.distanceTo(me) < 16)
      .map((e) => ({
        name: e.name || e.username || (e.displayName && e.displayName.toString()),
        kind: e.type,
        dist: round(e.position.distanceTo(me))
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 15)
    return { nearby }
  }
}

// ---------- Создание бота + переподключение ----------
function createBot () {
  console.log(`[бот] Подключаюсь к ${config.host}:${config.port} как «${config.username}»...`)
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: 'offline', // мир Open to LAN работает в offline-режиме, аккаунт не нужен
    version: VERSION
  })

  bot.loadPlugin(pathfinder)

  bot.once('spawn', () => {
    defaultMove = new Movements(bot)
    console.log(`[бот] Зашёл в мир! Версия сервера: ${bot.version}`)
    sendEvent('ready', getState())
    setInterval(() => {
      if (bot && bot.entity) sendEvent('state', getState())
    }, 2000)
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    console.log(`[чат] <${username}> ${message}`)
    sendEvent('chat', { username, message })
  })

  bot.on('health', () => {
    sendEvent('health', { health: bot.health, food: bot.food })
  })

  bot.on('death', () => {
    console.log('[бот] Я умер :(')
    sendEvent('death', {})
  })

  bot.on('kicked', (reason) => {
    console.log('[бот] Меня кикнули:', reason)
    sendEvent('kicked', { reason: String(reason) })
  })

  bot.on('error', (err) => {
    console.log('[бот] Ошибка:', err.message)
  })

  bot.on('end', (reason) => {
    console.log('[бот] Отключился от сервера:', reason, '— переподключусь через 5с')
    sendEvent('disconnected', { reason: String(reason) })
    setTimeout(createBot, 5000)
  })
}

createBot()
