'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { parseRequest, shouldProbePending, resolve, isMissing } = require('../lib/status')

test('parseRequest accepts a well-formed aligned request', () => {
  assert.deepStrictEqual(parseRequest({ room: 'W1N1', time: '24900' }, 100), { room: 'W1N1', time: 24900 })
})

test('parseRequest rejects a missing or empty room', () => {
  assert.strictEqual(parseRequest({ time: '100' }, 100).reason, 'missing_room')
  assert.strictEqual(parseRequest({ room: '  ', time: '100' }, 100).reason, 'missing_room')
})

test('parseRequest rejects a room name that could escape the history directory', () => {
  // The file adapter interpolates the room straight into a path, so this is a traversal, not a
  // typo: upstream would happily read ../../etc/passwd.json.gz.
  assert.strictEqual(parseRequest({ room: '../../etc/passwd', time: '100' }, 100).reason, 'bad_room')
  assert.strictEqual(parseRequest({ room: 'W1N1/..', time: '100' }, 100).reason, 'bad_room')
})

test('parseRequest rejects a tick that is not a non-negative integer', () => {
  for (const time of ['', undefined, null, 'abc', '10.5', '-100', {}]) {
    assert.strictEqual(parseRequest({ room: 'W1N1', time }, 100).reason, 'bad_time', `time=${String(time)}`)
  }
})

test('parseRequest rejects a tick that is not a chunk boundary', () => {
  assert.strictEqual(parseRequest({ room: 'W1N1', time: '24950' }, 100).reason, 'misaligned')
})

test('parseRequest skips the alignment check when the chunk size is unknown', () => {
  assert.deepStrictEqual(parseRequest({ room: 'W1N1', time: '24950' }, 0), { room: 'W1N1', time: 24950 })
})

test('resolve serves a chunk that was found', () => {
  assert.deepStrictEqual(
    resolve({ outcome: 'found', time: 100, chunkSize: 100, gameTime: 500, keepTicks: 200000 }),
    { status: 200, reason: 'ok' }
  )
})

test('resolve reports a read failure as a fault, not as absence', () => {
  assert.deepStrictEqual(
    resolve({ outcome: 'error', time: 100, chunkSize: 100, gameTime: 500, keepTicks: 200000 }),
    { status: 500, reason: 'read_failed' }
  )
})

test('resolve asks the caller back when the window is still open', () => {
  // The chunk based at 500 covers ticks 500-599, so at tick 550 it cannot exist yet.
  assert.deepStrictEqual(
    resolve({ outcome: 'missing', time: 500, chunkSize: 100, gameTime: 550, keepTicks: 200000 }),
    { status: 425, reason: 'window_open' }
  )
})

test('resolve asks the caller back when the upload has not happened yet', () => {
  assert.deepStrictEqual(
    resolve({ outcome: 'missing', time: 500, chunkSize: 100, gameTime: 700, keepTicks: 200000, pending: true }),
    { status: 425, reason: 'upload_pending' }
  )
})

test('resolve settles a closed window with nothing stored and nothing pending', () => {
  assert.deepStrictEqual(
    resolve({ outcome: 'missing', time: 500, chunkSize: 100, gameTime: 700, keepTicks: 200000 }),
    { status: 404, reason: 'no_record' }
  )
})

test('resolve separates trimmed history from history that never existed', () => {
  assert.deepStrictEqual(
    resolve({ outcome: 'missing', time: 500, chunkSize: 100, gameTime: 300000, keepTicks: 200000 }),
    { status: 410, reason: 'expired' }
  )
})

test('resolve treats a retention horizon of zero as "never trimmed"', () => {
  assert.deepStrictEqual(
    resolve({ outcome: 'missing', time: 500, chunkSize: 100, gameTime: 300000, keepTicks: 0 }),
    { status: 404, reason: 'no_record' }
  )
})

test('resolve refuses to call anything absent while the clock is unreadable', () => {
  assert.deepStrictEqual(
    resolve({ outcome: 'missing', time: 500, chunkSize: 100, gameTime: null, keepTicks: 200000 }),
    { status: 503, reason: 'clock_unavailable' }
  )
})

test('shouldProbePending covers the worker backfill window and stops there', () => {
  assert.strictEqual(shouldProbePending({ time: 500, chunkSize: 100, gameTime: 800 }), true)
  assert.strictEqual(shouldProbePending({ time: 500, chunkSize: 100, gameTime: 900 }), true)
  assert.strictEqual(shouldProbePending({ time: 500, chunkSize: 100, gameTime: 901 }), false)
  assert.strictEqual(shouldProbePending({ time: 500, chunkSize: 100, gameTime: null }), false)
  assert.strictEqual(shouldProbePending({ time: 500, chunkSize: 0, gameTime: 800 }), false)
})

test('isMissing recognises absence from every adapter upstream ships', () => {
  assert.strictEqual(isMissing(Object.assign(new Error('x'), { code: 'ENOENT' })), true)
  assert.strictEqual(isMissing(Object.assign(new Error('x'), { code: 'NoSuchKey' })), true)
  assert.strictEqual(isMissing(Object.assign(new Error('x'), { statusCode: 404 })), true)
  assert.strictEqual(isMissing(new Error('Record not found')), true)
})

test('isMissing does not mistake a fault for absence', () => {
  assert.strictEqual(isMissing(Object.assign(new Error('x'), { code: 'EACCES' })), false)
  assert.strictEqual(isMissing(new Error('SQLITE_BUSY: database is locked')), false)
  assert.strictEqual(isMissing(new Error('incorrect header check')), false)
  assert.strictEqual(isMissing(null), false)
  assert.strictEqual(isMissing('Record not found'), false)
})
