const shared = require('./shared')
const { createHandler } = require('./roomHistory')

module.exports = function (config) {
  config.backend.historyChunkSize = config.history.opts.historyChunkSize
  config.backend.onGetRoomHistory = function (roomName, baseTime, callback) {
    shared.read(roomName, baseTime, callback)
  }

  // The backend's own /room-history answers 500 for everything onGetRoomHistory can fail with: a
  // room that was quiet, a chunk that is not written yet, one that was trimmed, a misaligned
  // request and a failing disk are one answer, so a client must either retry all of them - most
  // rooms are empty in most windows - or write them all off, which turns one bad moment into a
  // permanent hole. That route is registered after expressPreConfig is emitted, so a route
  // mounted here matches first and gives each case its own status.
  if (config.history.opts.statusCodes === false) return
  config.backend.on('expressPreConfig', app => {
    app.use('/room-history', createHandler(config, shared))
  })
}
