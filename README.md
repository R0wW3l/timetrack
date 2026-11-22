# Timetrack

A single-user time tracker that runs locally in Docker. It does not call the network, require an account, or store data anywhere except the folder you mount.

- Docker Hub: [rwel/timetrack](https://hub.docker.com/r/rwel/timetrack) (Intel and Apple Silicon)
- Source: [github.com/R0wW3l/timetrack](https://github.com/R0wW3l/timetrack)

## Where your data lives

Everything the app stores is in one folder: `timetrack.db`, `config.json`, and `active.json` when a timer is running. That folder is not inside the image. Docker mounts it at `/data`, so you can delete, update, or rebuild the container without losing entries.

Point every computer at the same shared folder. The files do not record the computer's path, so each machine only needs its own mount:

```bash
docker run -d --name timetrack --restart unless-stopped \
  -p 8080:8080 \
  -v "/Users/rw/pCloud Drive/TimeTrack:/data" \
  -e DATA_FOLDER=/data \
  -e TZ=America/Edmonton \
  rwel/timetrack:latest
```

On a computer where that shared folder has a different path, change the left side of `-v` and leave `/data` as it is. If the folder is missing or empty, the first start creates the database there. Files already in the folder are left in place.

One computer should use the database at a time. Syncing `timetrack.db` while Timetrack is open can corrupt it.

## Run it from Docker Hub

```bash
docker run -d --name timetrack --restart unless-stopped \
  -p 8080:8080 \
  -v "/Users/rw/pCloud Drive/TimeTrack:/data" \
  -e DATA_FOLDER=/data \
  -e TZ=America/Edmonton \
  rwel/timetrack:latest
```

Open [http://localhost:8080](http://localhost:8080).

Always pass the `-v` flag. Without it, Docker keeps the database in an anonymous volume instead of the shared folder.

To update to a newer version:

```bash
docker pull rwel/timetrack:latest
docker rm -f timetrack
# then run the same docker run command again
```

## Run it with Compose

[docker-compose.yml](docker-compose.yml) mounts `DATA_FOLDER` at `/data`. A `.env` file next to it can set that path, including a path with a space:

```bash
DATA_FOLDER=/Users/rw/pCloud Drive/TimeTrack
```

From this folder:

```bash
docker compose up -d          # pulls rwel/timetrack:latest
docker compose up -d --build  # builds from this source instead
```

With no `.env`, Compose uses `~/timetrack-data`.

## Using it for several jobs

- **Track:** type a project or task name. Pick an existing one from the suggestions, or type a new name and press Start to add it. New projects get the default hourly wage, which you can change in Settings.
- **Entries and Report:** the Projects and Tasks filters each accept several selections. Leave a filter blank to include everything. Tasks are listed under their project and narrow to the projects you select. The PDF header lists the filters that were used.
- **Settings:** press the × on a task, or Delete next to a project's Save button, to delete it. Deleting a project also deletes its tasks. If there are time entries, you choose whether to delete them too or keep them. Kept entries still show their project and task name, and you can move them to another project from Entries.

## First start

On the first boot the server creates two files in the data folder:

- `config.json`, copied from `GrokFiles/config.template.json`
- `timetrack.db`, created from `GrokFiles/schema.sql`

The default hourly wage is 45 CAD. The container timezone is `America/Edmonton`. Each entry still stores the browser offset from the moment it was saved, so older entries keep their original local time.

## Back up the SQLite file

SQLite is in WAL mode. Copying `timetrack.db` alone can miss the newest commits, which live in `timetrack.db-wal` until a checkpoint.

Stop the container, checkpoint, then copy the database and the two JSON files:

```bash
DATA_FOLDER="/Users/rw/pCloud Drive/TimeTrack"
docker stop timetrack
sqlite3 "$DATA_FOLDER/timetrack.db" "PRAGMA wal_checkpoint(TRUNCATE);"
cp "$DATA_FOLDER/timetrack.db" "$DATA_FOLDER/timetrack-backup.db"
cp "$DATA_FOLDER/config.json" "$DATA_FOLDER/config-backup.json"
if [ -f "$DATA_FOLDER/active.json" ]; then
  cp "$DATA_FOLDER/active.json" "$DATA_FOLDER/active-backup.json"
fi
docker start timetrack
```

After `wal_checkpoint(TRUNCATE)`, the `-wal` and `-shm` files are empty and the `.db` file is the whole database. To restore, stop the app and replace `timetrack.db` with the backup.
