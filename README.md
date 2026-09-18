# screepsmod-history

## This is a history mod for the Screeps Private Server

[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![CircleCI](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master.svg?style=shield)](https://circleci.com/gh/ScreepsMods/screepsmod-mongo/tree/master)

[![NPM info](https://nodei.co/npm/screepsmod-history.png?downloads=true)](https://npmjs.org/package/screepsmod-history)

## Requirements

* nodejs 12+
* Plenty of disk space, I see an average of 8kb per tick per room, by default this saves 200,000 ticks. So ~20MB per active room.

## Warning
Currently with AWS mode this produces a lot of PUT requests, this can easily become very expensive. 
For that reason, AWS mode is currently not recommended

## Configuration

All options and defaults are listed below

### History

* historyChunkSize: 100 (Number of ticks per history file)
* statusCodes: true (Report what `/room-history` actually found - see below. Set `false` for the old behaviour, where everything is a 500)
* mode: sqlite (valid values are `file`, `aws`, and `sqlite`)
* region: us-east-1
* apiVersion: latest
* accessKeyId: 
* secretAccessKey: 
* bucket: 
* path: history


## Examples

Config can be applied in several ways:

### .screepsrc

Add to the bottom of your .screepsrc file
```
[history]
historyChunkSize = 100
mode = 'aws'
region = 'us-east-1'
apiVersion = 'latest'
accessKeyId = 'my-aws-access-key-id'
secretAccessKey = 'my-aws-secret-access-key'
bucket = 'my-bucket'
path = 'my-custom-path'
```

## Room history responses

The backend's own `/room-history` turns every error into a bare 500, so a room that was quiet, a
chunk that has not been written yet, one that was trimmed, a misaligned request and a failing disk
are all the same answer. A client then has to choose between retrying everything - most rooms are
empty in most windows - and writing every 500 off, which turns one bad moment into a permanent hole
in its record.

This mod mounts its own route from `expressPreConfig`, which the backend emits before it registers
that one, so each case gets its own status:

| Status | `X-History-Status` | Meaning | Worth retrying? |
|---|---|---|---|
| 200 | — | the chunk | — |
| 400 | `missing_room`, `bad_room`, `bad_time`, `misaligned` | a request that cannot be satisfied - in particular a tick that is not a multiple of `historyChunkSize` | no, fix the request |
| 404 | `no_record` | the window is closed and this room produced nothing in it | **no** |
| 410 | `expired` | nothing stored, and older than `HISTORY_KEEP_TICKS` | no |
| 425 | `window_open` | the window has not finished yet | yes |
| 425 | `upload_pending` | the ticks are in storage; the worker has not rolled them up | yes |
| 500 | `read_failed` | the adapter failed - a locked database, a bad gzip, a permissions error | yes, with backoff |
| 503 | `clock_unavailable` | the world clock could not be read, so absence cannot be told from earliness | yes |

The reason is in both the header and the JSON body, so `curl -sI` is enough to tell them apart.

`upload_pending` is decided from the engine's own bookkeeping: each tick is parked under
`roomHistory:<baseTick>:<room>` with a TTL and the worker deletes that key once the chunk is
uploaded, so a TTL lookup answers "was this room producing history in that window?" for any window
the worker can still reach.

Two things this changes besides the status: a read failure is now logged by the server, where
before it was sent to the client and nowhere else, and the room name is validated, because the file
adapter interpolates it straight into a path.

It cannot tell you a chunk was *lost*. Past the worker's backfill window, a room that was quiet and
a room whose chunk died with the server are both simply absent; nothing records which rooms were
meant to be written.

Set `statusCodes = false` to keep the old single-500 behaviour.

### ENV Method

Please note that this method only works when launching modules directly or with screeps-launcher, when launched via the default launcher they will be ignored.

```
HISTORY_MODE='aws'
```
