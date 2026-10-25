# Timetrack

A single-user time tracker that runs locally in Docker. It does not call the network, require an account, or store data anywhere except the folder you mount.

- Docker Hub: [rwel/timetrack](https://hub.docker.com/r/rwel/timetrack) (Intel and Apple Silicon)
- Source: [github.com/R0wW3l/timetrack](https://github.com/R0wW3l/timetrack)

## Where your data lives

The database, config, and running timer live in a folder on your computer, not in the image or the container. By default that folder is `timetrack-data` in your home directory (`~/timetrack-data`). Docker mounts it at `/data` inside the container, so you can delete, update, or rebuild the container without losing anything.

## Run it from Docker Hub

```bash
mkdir -p "$HOME/timetrack-data"
docker run -d --name timetrack --restart unless-stopped \
  -p 8080:8080 \
  -v "$HOME/timetrack-data:/data" \
  -e TZ=America/Edmonton \
  rwel/timetrack:latest
```

Open [http://localhost:8080](http://localhost:8080).

On Windows PowerShell, use `-v "$env:USERPROFILE\timetrack-data:/data"`.

Always pass the `-v` flag. Without it, Docker keeps the data in an anonymous volume instead of your home folder.

To update to a newer version:

```bash
docker pull rwel/timetrack:latest
docker rm -f timetrack
# then run the same docker run command again
```

## Run it with Compose

[docker-compose.yml](docker-compose.yml) mounts `~/timetrack-data` by default. From this folder:

```bash
docker compose up -d          # pulls rwel/timetrack:latest
docker compose up -d --build  # builds from this source instead
```

To keep the data somewhere else, set `DATA_FOLDER` to the host path first:

```bash
export DATA_FOLDER="$HOME/Dropbox/timetrack-data"
docker compose up -d
```

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
DATA_FOLDER="$HOME/timetrack-data"
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
