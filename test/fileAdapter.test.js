const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The adapter resolves its base path from process.env.MODFILE, so a real temp directory and a
// real MODFILE are used throughout rather than mocking fs: this is exactly the path that broke,
// and a mock would not have caught it - mocked fs.readdirAsync would simply resolve however the
// mock said to, never reproducing the real ENOENT an absent directory raises.
function withTempModfile (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screepsmod-history-'))
  const previous = process.env.MODFILE
  process.env.MODFILE = path.join(root, 'mods.json')
  t.after(() => {
    if (previous === undefined) delete process.env.MODFILE
    else process.env.MODFILE = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function loadAdapter () {
  // Each test gets its own MODFILE-derived base path, and the adapter reads that lazily per call
  // (getRoomPath), so re-requiring is unnecessary - a fresh instance per test is enough.
  delete require.cache[require.resolve('../lib/adapters/file')]
  const FileAdapter = require('../lib/adapters/file')
  return new FileAdapter({ path: 'history' })
}

test('cleanup resolves, rather than rejecting unhandled, when a room has never produced a chunk', async (t) => {
  withTempModfile(t)
  const adapter = loadAdapter()

  // The room's directory (history/W1N9) was never created - no write() has ever happened for it,
  // which is the common case: most rooms in a benchmark map produce nothing.
  await assert.doesNotReject(() => adapter.cleanup('W1N9', 60000))
})

test('cleanup still removes files older than the cutoff and leaves newer ones', async (t) => {
  const root = withTempModfile(t)
  const adapter = loadAdapter()
  const dir = path.join(root, 'history', 'W1N1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '100.json.gz'), 'old')
  fs.writeFileSync(path.join(dir, '60100.json.gz'), 'new')

  await adapter.cleanup('W1N1', 60000)

  assert.deepStrictEqual(fs.readdirSync(dir), ['60100.json.gz'])
})

test('cleanup still propagates a real failure, not just an absent directory', async (t) => {
  const root = withTempModfile(t)
  const adapter = loadAdapter()
  // A file where a directory is expected: readdir fails with ENOTDIR, not ENOENT - a genuine
  // fault, and the whole point of the fix is that only "nothing there" is swallowed.
  const dir = path.join(root, 'history')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'W1N1'), 'not a directory')

  await assert.rejects(() => adapter.cleanup('W1N1', 60000), err => err.code === 'ENOTDIR')
})
