// Keep processor copies until the adapter's group commit is durable. The history endpoint treats
// a missing adapter file and a missing processor key as a final 404, so clearing first can make a
// concurrent tracker read a false absence.
async function writeHistoryRecordsBeforeDelete (shared, env, records, onWriteError = () => {}) {
  if (shared.beginGroup) await shared.beginGroup()

  const written = []
  for (const record of records) {
    try {
      await shared.write(record.room, record.baseTick, record.result)
      written.push(record)
    } catch (err) {
      onWriteError(record, err)
    }
  }

  // A transaction-backed adapter does not make the records visible until this succeeds. On a
  // commit failure, leave every processor key so the next roomsDone event can retry the batch.
  if (shared.endGroup) await shared.endGroup()

  for (const record of written) await env.del(record.key)
}

module.exports = { writeHistoryRecordsBeforeDelete }
