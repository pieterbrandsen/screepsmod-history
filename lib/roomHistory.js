const { STATUS, parseRequest, shouldProbePending, resolve, isMissing } = require('./status')

const DEFAULT_KEEP_TICKS = 200000

// Read the world clock. Returns null rather than throwing: a request that cannot see the clock
// still has an honest answer to give, it just is not "no record".
async function readGameTime (env) {
  try {
    const gameTime = Number(await env.get(env.keys.GAMETIME))
    return Number.isFinite(gameTime) ? Math.floor(gameTime) : null
  } catch (e) {
    return null
  }
}

// Whether the processors' per-tick data for this chunk is still waiting to be rolled up. This is
// the one fact separating "this room was quiet" from "this chunk is not written yet": the engine
// parks each tick under roomHistory:<baseTick>:<room> with a TTL and the worker deletes the key
// once it has uploaded. A TTL lookup is type-agnostic, which matters because that key is a hash
// under some storage backends and a string under others.
async function readPending (env, room, time) {
  try {
    const ttl = await env.ttl(`${env.keys.ROOM_HISTORY}${time}:${room}`)
    return typeof ttl === 'number' && ttl !== -2
  } catch (e) {
    return false
  }
}

async function readChunk (shared, room, time) {
  try {
    const data = await shared.read(room, time)
    // An adapter that resolves with nothing has not found anything, whatever it thinks it did.
    if (data === undefined || data === null) return { outcome: 'missing' }
    return { outcome: 'found', data }
  } catch (err) {
    return isMissing(err) ? { outcome: 'missing' } : { outcome: 'error', error: err }
  }
}

function send (response, { status, reason }, extra) {
  // The reason travels in a header as well as the body, so `curl -I` is enough to tell the cases
  // apart without a client having to parse anything.
  response.set('X-History-Status', reason)
  return response.status(status).json(Object.assign({ error: reason }, extra))
}

// Build the /room-history middleware.
function createHandler (config, shared, log) {
  const report = log || console.error
  return function roomHistory (request, response, next) {
    // The backend applies this to everything registered after it, and this route registers
    // before it - so without repeating the check, a password-protected server's history would be
    // readable by anyone.
    if (process.env.SERVER_PASSWORD &&
        request.get('X-Server-Password') !== process.env.SERVER_PASSWORD) {
      return response.status(403).json({ error: 'incorrect server password' })
    }

    const chunkSize = Number(config.history.opts.historyChunkSize) || 0
    const parsed = parseRequest(request.query || {}, chunkSize)
    if (parsed.status) return send(response, parsed)

    const { room, time } = parsed
    const keepTicks = Number(process.env.HISTORY_KEEP_TICKS) || DEFAULT_KEEP_TICKS

    Promise.resolve()
      .then(async () => {
        // Resolved inside the chain, not above it: a config without storage would otherwise throw
        // synchronously, past the catch, and the request would hang instead of being answered.
        const env = (config.common && config.common.storage && config.common.storage.env) || null

        const read = await readChunk(shared, room, time)
        if (read.outcome === 'found') return response.send(read.data)

        if (read.outcome === 'error') {
          // Otherwise this reaches the client and nowhere else, and a failing disk looks like a
          // quiet room to whoever runs the server.
          report('[history] read failed', room, time, read.error)
        }

        const gameTime = await readGameTime(env)
        const pending = read.outcome === 'missing' &&
          shouldProbePending({ time, chunkSize, gameTime }) &&
          await readPending(env, room, time)

        return send(response, resolve({
          outcome: read.outcome, time, chunkSize, gameTime, keepTicks, pending
        }), { room, time })
      })
      .catch(err => {
        report('[history] request failed', room, time, err)
        send(response, { status: STATUS.READ_FAILED, reason: 'handler_failed' }, { room, time })
      })
  }
}

module.exports = { createHandler, readGameTime, readPending, readChunk, DEFAULT_KEEP_TICKS }
