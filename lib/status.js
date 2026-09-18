// Deciding what /room-history should answer, with no server attached.
//
// The backend turns every error from onGetRoomHistory into one 500, so a client cannot tell a
// quiet room from a chunk that is not written yet from a failing disk. These are the answers it
// can be given instead, and the rules for choosing between them.
const STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  GONE: 410,
  TOO_EARLY: 425,
  READ_FAILED: 500,
  UNAVAILABLE: 503
}

// The room reaches the file adapter as a path segment and the tick as a filename, so neither is
// trusted: without this, ?room=../../etc/passwd is a directory traversal.
const ROOM_NAME = /^[A-Za-z0-9_-]{1,32}$/

// How far past the end of a window the worker can still be catching up: it re-checks the last
// three chunks on each roomsDone at a chunk boundary. Older than this, a missing chunk is missing
// for good, and probing storage for a pending upload is a round-trip spent on a known answer.
const BACKFILL_CHUNKS = 4

// Validate a request before anything is read.
function parseRequest (query, chunkSize) {
  const room = typeof query.room === 'string' ? query.room.trim() : ''
  if (!room) return { status: STATUS.BAD_REQUEST, reason: 'missing_room' }
  if (!ROOM_NAME.test(room)) return { status: STATUS.BAD_REQUEST, reason: 'bad_room' }

  const raw = typeof query.time === 'string' ? query.time.trim() : query.time
  const time = Number(raw)
  if (raw === '' || raw === undefined || raw === null || !Number.isInteger(time) || time < 0) {
    return { status: STATUS.BAD_REQUEST, reason: 'bad_time' }
  }

  // Chunks are only written at a multiple of the chunk size, so any other tick asks for a file
  // that cannot exist. Saying so is the difference between a client fixing its stepping and a
  // client retrying forever.
  if (chunkSize > 0 && time % chunkSize !== 0) {
    return { status: STATUS.BAD_REQUEST, reason: 'misaligned' }
  }

  return { room, time }
}

// Whether a missing chunk is worth a storage round-trip to see if its upload is still pending.
function shouldProbePending ({ time, chunkSize, gameTime }) {
  if (gameTime === null || chunkSize <= 0) return false
  return gameTime - time <= chunkSize * BACKFILL_CHUNKS
}

// The whole decision, once the adapter has been asked.
function resolve ({ outcome, time, chunkSize, gameTime, keepTicks, pending = false }) {
  if (outcome === 'found') return { status: STATUS.OK, reason: 'ok' }
  if (outcome === 'error') return { status: STATUS.READ_FAILED, reason: 'read_failed' }

  // Without the clock an empty room cannot be told from one whose window is still open, and
  // answering 404 to the second is how one bad moment becomes a permanent hole in a client's
  // record. Say "ask again" and let the caller decide how patient to be.
  if (gameTime === null) return { status: STATUS.UNAVAILABLE, reason: 'clock_unavailable' }

  if (time + chunkSize > gameTime) return { status: STATUS.TOO_EARLY, reason: 'window_open' }
  if (pending) return { status: STATUS.TOO_EARLY, reason: 'upload_pending' }

  // Only reached when nothing is stored. Cleanup runs per room and only on chunk boundaries
  // divisible by 1000, so plenty of data older than the horizon is still there and is served
  // normally: this says "it is gone", not "it is too old to serve".
  if (keepTicks > 0 && time < gameTime - keepTicks) return { status: STATUS.GONE, reason: 'expired' }

  return { status: STATUS.NOT_FOUND, reason: 'no_record' }
}

// Whether an adapter error means "no such chunk" rather than "the read failed". The adapters do
// not agree: fs raises ENOENT, the S3 SDK NoSuchKey, and sqlite a bare Error whose message is the
// only thing separating it from a database fault.
function isMissing (err) {
  if (!err || typeof err !== 'object') return false
  const code = err.code || err.Code
  if (code === 'ENOENT' || code === 'NoSuchKey') return true
  if (err.statusCode === 404) return true
  return /^record not found$/i.test(String(err.message || '').trim())
}

module.exports = { STATUS, BACKFILL_CHUNKS, parseRequest, shouldProbePending, resolve, isMissing }
