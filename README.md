# Timetrack

A single-user time tracker that runs locally in Docker. It does not call the network, require an account, or store data anywhere except the folder you mount.

- Docker Hub: [rwel/timetrack](https://hub.docker.com/r/rwel/timetrack) (Intel and Apple Silicon)
- Source: [github.com/R0wW3l/timetrack](https://github.com/R0wW3l/timetrack)

## Where your data lives

The database, preferences, and running timer live in a folder on your computer, not in the image or the container. On a new install that folder is `timetrack-data` in your home directory (`~/timetrack-data`). Docker mounts it at `/data` inside the container, so you can delete, update, or rebuild the container without losing entries.

The folder you choose is saved in `~/.timetrack/settings.json`, which Compose mounts at `/settings`. That file is only the pointer. The database stays in the data folder.

Open **Settings** and enter a full path:

- A folder that already contains `timetrack.db` is opened.
- A path that does not exist yet, or an empty folder, is created and initialized.
- A folder with other files and no Timetrack database asks before creating a new database beside those files. Nothing already in the folder is deleted, and entries in the previous folder stay there.

Stop a running timer before changing the folder.

With Docker, the path has to be mounted into the container at that same path. A path that is only inside the container is deleted when the container is replaced.

A cloud folder such as pCloud or Dropbox can hold the files, but one computer should use the database at a time. Syncing `timetrack.db` while Timetrack is open can corrupt it.

## Run it from Docker Hub

```bash
mkdir -p "$HOME/timetrack-data" "$HOME/.timetrack"
docker run -d --name timetrack --restart unless-stopped \
  -p 8080:8080 \
  -v "$HOME/timetrack-data:/data" \
  -v "$HOME/.timetrack:/settings" \
  -e DATA_FOLDER=/data \
  -e SETTINGS_FOLDER=/settings \
  -e TZ=America/Edmonton \
  rwel/timetrack:latest
```

Open [http://localhost:8080](http://localhost:8080).

On Windows PowerShell, use `-v "$env:USERPROFILE\timetrack-data:/data"` and `-v "$env:USERPROFILE\.timetrack:/settings"`.

Always pass the `-v` flags. Without the data volume, Docker keeps the database in an anonymous volume instead of your home folder.

To choose a folder outside `timetrack-data`, mount its parent at the same path and then set the folder in Settings:

```bash
docker run -d --name timetrack --restart unless-stopped \
  -p 8080:8080 \
  -v "$HOME/timetrack-data:/data" \
  -v "$HOME/.timetrack:/settings" \
  -v "$HOME/Dropbox:$HOME/Dropbox" \
  -e DATA_FOLDER=/data \
  -e SETTINGS_FOLDER=/settings \
  -e TZ=America/Edmonton \
  rwel/timetrack:latest
```

Settings can then use a path such as `/Users/you/Dropbox/timetrack-data`.

To update to a newer version:

```bash
docker pull rwel/timetrack:latest
docker rm -f timetrack
# then run the same docker run command again
```

## Run it with Compose

[docker-compose.yml](docker-compose.yml) mounts `~/timetrack-data` and `~/.timetrack` by default. From this folder:

```bash
docker compose up -d          # pulls rwel/timetrack:latest
docker compose up -d --build  # builds from this source instead
```

`DATA_MOUNT` is the directory Docker shares so Settings can use a path inside it. It defaults to the data folder. Point it at a parent such as Dropbox or pCloud Drive, then choose the folder in Settings. The Compose file quotes these paths, so a name with a space works:

```bash
export DATA_MOUNT="$HOME/pCloud Drive"
docker compose up -d
```

To keep the default database somewhere else before the first launch, set `DATA_FOLDER` to that host path:

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
