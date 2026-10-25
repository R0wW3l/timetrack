# API Route Spec (for Grok to implement)

Base URL: http://localhost:8080/api

## Projects
GET    /projects                -> list all projects (id, name, hourlyWageCad)
POST   /projects                -> { name, hourlyWageCad } create new project
PUT    /projects/:id             -> update name / hourlyWageCad

## Tasks
GET    /tasks?projectId=:id      -> list tasks for a project (id, projectId, name, entryCount)
GET    /tasks                    -> list every task, same shape
POST   /tasks                    -> { projectId, name } create new task (or return existing if name+projectId already exists)
DELETE /tasks/:id?entries=delete|keep
                                 -> delete a task. If it has entries, `entries` is required:
                                    delete removes them, keep leaves them with the task name stored on the entry.
                                    409 while the running timer uses the task.
                                    returns { deletedEntries, keptEntries }

## Timer (active.json backed)
GET    /timer                    -> current active timer state, or { isRunning: false }
POST   /timer/start              -> { projectId, taskId, notesDraft, tzOffsetMinutes } -> writes active.json atomically, returns state
                                     tzOffsetMinutes is the ISO offset in minutes (Edmonton MDT = -360),
                                     stored on active.json and copied onto the entry at stop.
PUT    /timer                    -> { notesDraft }
                                     -> updates notesDraft on the running timer only.
                                        Rewrites active.json with the same temp-file, fsync, rename
                                        pattern as start. Does not change start time, project, task,
                                        or tzOffsetMinutes.
                                        409 { error } if no timer is running.
                                        returns the full timer state:
                                        { isRunning, startUtc, tzOffsetMinutes, projectId, projectName,
                                          taskId, taskName, notesDraft }
POST   /timer/stop               -> { notes, amountCad? (optional override) }
                                     -> reads active.json, computes duration + amount from project wage,
                                        checks for overlap against existing entries in that time range,
                                        commits new row to entries table, clears active.json,
                                        returns { entry, overlapWarning: bool, overlappingEntryIds: [] }

## Entries
GET    /entries?from=ISO_DATE&to=ISO_DATE
    -> list entries in range (inclusive), each with joined project/task names, ordered by start_utc desc
    -> response also includes { totalDurationSeconds, totalAmountCad } for the filtered range

POST   /entries                  -> manual entry creation { projectId, taskId, startUtc, finishUtc, tzOffsetMinutes, notes, amountCad? }
                                     -> server checks overlap, returns { entry, overlapWarning, overlappingEntryIds }

PUT    /entries/:id               -> full edit of any field (start, finish, project, task, notes, amount)
                                     -> re-checks overlap on every edit, returns same overlap warning shape

DELETE /entries/:id               -> hard delete a single entry

## Reports
POST   /reports/pdf              -> { from: ISO_DATE, to: ISO_DATE }
                                     -> generates PDF via PDFKit server-side, streams file back as
                                        Content-Type: application/pdf, Content-Disposition: attachment
                                     -> PDF contents: title + date range, table of entries
                                        (date, start, finish, duration, project, task, notes, amount CAD),
                                        footer with totals (total hours, total CAD owed)

## Config
GET    /config                   -> current config.json contents
PUT    /config                   -> update config.json (atomic temp-file write, same pattern as active.json)

# Notes for implementation
- All *_utc fields are ISO 8601 strings in UTC. tzOffsetMinutes stores the client's offset
  at the time of entry so the UI can redisplay in the original local time if desired.
- Overlap check: an entry [start,finish) overlaps another existing entry for ANY project if
  start < other.finish AND finish > other.start. Return overlapping entries; never block the save.
- amountCad auto-computes as (duration_seconds / 3600) * project.hourlyWageCad unless the
  client explicitly sets amount_overridden = true with a manual value.
- active.json writes: write to active.json.tmp in the same directory, fsync, rename over active.json.
  Clear it (delete or set isRunning:false) only AFTER the SQLite commit for /timer/stop succeeds.
- On server startup, run `PRAGMA wal_checkpoint(TRUNCATE);` once before opening for requests,
  and check for a leftover active.json to let the UI resume/display a running timer after a restart.
