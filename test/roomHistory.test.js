const test = require('node:test')
const assert = require('node:assert')
const { createHandler } = require('../lib/roomHistory')

// A response that records what was sent and resolves once something terminal happens.
function fakeResponse () {
  const sent = { headers: {} }
  sent.done = new Promise(resolve => {
    sent.settle = () => resolve(sent)
  })
  return Object.assign(sent, {
    set (name, value) { sent.headers[name] = value; return sent },
    status (code) { sent.statusCode = code; return sent },
    json (body) { sent.body = body; sent.settle(); return sent },
    send (body) { sent.body = body; sent.statusCode = sent.statusCode || 200; sent.settle(); return sent }
  })
}

function fakeConfig ({ gameTime = 1000, ttl = -2, chunkSize = 100 } = {}) {
  return {
    history: { opts: { historyChunkSize: chunkSize } },
    common: {
      storage: {
        env: {
          keys: { GAMETIME: 'gameTime', ROOM_HISTORY: 'roomHistory:' },
          get: async () => (gameTime === null ? Promise.reject(new Error('no storage')) : String(gameTime)),
          ttl: async () => ttl
        }
      }
    }
  }
}

const request = (query = { room: 'W1N1', time: '500' }) => ({ query, get: () => undefined })
const absent = () => Object.assign(new Error('nope'), { code: 'ENOENT' })

// Drive the handler and wait for whatever it decides to send.
function run (config, read, req = request(), log = () => {}) {
  const response = fakeResponse()
  createHandler(config, { read }, log)(req, response, () => response.settle())
  return response.done
}

test('serves the chunk when the adapter has it', async () => {
  const sent = await run(fakeConfig(), async () => ({ ticks: { 500: {} } }))
  assert.strictEqual(sent.statusCode, 200)
  assert.deepStrictEqual(sent.body, { ticks: { 500: {} } })
})

test('reports an open window rather than absence', async () => {
  const sent = await run(fakeConfig({ gameTime: 550 }), async () => { throw absent() })
  assert.strictEqual(sent.statusCode, 425)
  assert.strictEqual(sent.headers['X-History-Status'], 'window_open')
})

test('reports a pending upload rather than absence', async () => {
  const sent = await run(fakeConfig({ gameTime: 700, ttl: 4200 }), async () => { throw absent() })
  assert.strictEqual(sent.statusCode, 425)
  assert.strictEqual(sent.headers['X-History-Status'], 'upload_pending')
})

test('settles a quiet room with a 404 a client can act on', async () => {
  const sent = await run(fakeConfig({ gameTime: 700 }), async () => { throw absent() })
  assert.strictEqual(sent.statusCode, 404)
  assert.deepStrictEqual(sent.body, { error: 'no_record', room: 'W1N1', time: 500 })
})

test('treats an adapter that resolves with nothing as absence', async () => {
  const sent = await run(fakeConfig({ gameTime: 700 }), async () => undefined)
  assert.strictEqual(sent.statusCode, 404)
})

test('keeps a real fault a 500, and says so in the server log', async () => {
  const faults = []
  const sent = await run(
    fakeConfig(),
    async () => { throw new Error('SQLITE_BUSY: database is locked') },
    request(),
    (...args) => faults.push(args)
  )
  assert.strictEqual(sent.statusCode, 500)
  assert.strictEqual(sent.headers['X-History-Status'], 'read_failed')
  assert.strictEqual(faults.length, 1)
})

test('answers 503, not 404, when the clock cannot be read', async () => {
  const sent = await run(fakeConfig({ gameTime: null }), async () => { throw absent() })
  assert.strictEqual(sent.statusCode, 503)
})

test('rejects a malformed request before touching the adapter', async () => {
  let reads = 0
  const sent = await run(fakeConfig(), async () => { reads++; return {} }, request({ room: 'W1N1', time: '550' }))
  assert.strictEqual(sent.statusCode, 400)
  assert.strictEqual(sent.headers['X-History-Status'], 'misaligned')
  assert.strictEqual(reads, 0)
})

test('keeps a password-protected server protected', async (t) => {
  // This route registers before the backend applies its own password check, so it has to apply
  // one itself or enabling it would open history to anyone.
  process.env.SERVER_PASSWORD = 'hunter2'
  t.after(() => { delete process.env.SERVER_PASSWORD })

  let reads = 0
  const read = async () => { reads++; return {} }
  const sent = await run(fakeConfig(), read)
  assert.strictEqual(sent.statusCode, 403)
  assert.strictEqual(reads, 0)

  const withPassword = { query: { room: 'W1N1', time: '500' }, get: () => 'hunter2' }
  const ok = await run(fakeConfig(), read, withPassword)
  assert.strictEqual(ok.statusCode, 200)
})

test('answers rather than hanging when storage is not wired up at all', async () => {
  // A config without storage must not become a 404: a client writing a window off on the strength
  // of a broken server is the permanent hole this exists to prevent.
  const config = fakeConfig()
  delete config.common
  const sent = await run(config, async () => { throw absent() })
  assert.strictEqual(sent.statusCode, 503)
  assert.strictEqual(sent.headers['X-History-Status'], 'clock_unavailable')
})
