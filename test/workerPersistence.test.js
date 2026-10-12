const test = require('node:test')
const assert = require('node:assert')
const { writeHistoryRecordsBeforeDelete } = require('../lib/historyPersistence')

test('keeps the pending room-history key until the durable write finishes', async () => {
  let finishCommit
  const commitGate = new Promise(resolve => { finishCommit = resolve })
  const state = { pending: true, written: false, committed: false }
  const shared = {
    beginGroup: async () => {},
    write: async () => { state.written = true },
    endGroup: async () => { await commitGate; state.committed = true }
  }
  const env = {
    del: async () => {
      assert.strictEqual(state.committed, true)
      state.pending = false
    }
  }

  const records = [{ room: 'W3N7', baseTick: 61300, key: 'roomHistory:61300:W3N7', result: {} }]
  const writing = writeHistoryRecordsBeforeDelete(shared, env, records)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepStrictEqual(state, { pending: true, written: true, committed: false })

  finishCommit()
  await writing
  assert.deepStrictEqual(state, { pending: false, written: true, committed: true })
})

test('keeps the pending key when the durable write fails', async () => {
  const deleted = []
  const shared = {
    write: async (room) => {
      if (room === 'W3N7') throw new Error('disk unavailable')
    },
    endGroup: async () => {}
  }
  const env = { del: async key => { deleted.push(key) } }
  const records = [
    { room: 'W3N7', baseTick: 61300, key: 'roomHistory:61300:W3N7', result: {} },
    { room: 'W7N3', baseTick: 61300, key: 'roomHistory:61300:W7N3', result: {} }
  ]

  await writeHistoryRecordsBeforeDelete(shared, env, records)
  assert.deepStrictEqual(deleted, ['roomHistory:61300:W7N3'])
})

test('keeps every pending key when the group commit fails', async () => {
  let deletes = 0
  const shared = {
    write: async () => {},
    endGroup: async () => { throw new Error('commit failed') }
  }

  await assert.rejects(
    writeHistoryRecordsBeforeDelete(shared, { del: async () => { deletes += 1 } }, [
      { room: 'W3N7', baseTick: 61300, key: 'roomHistory:61300:W3N7', result: {} }
    ]),
    /commit failed/
  )
  assert.strictEqual(deletes, 0)
})
