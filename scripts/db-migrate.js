const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const sqliteFile = process.env.SQLITE_FILE || path.join(dataDir, "itera.sqlite");
const jsonFile = path.join(dataDir, "db.json");
const migrationFile = path.join(root, "migrations", "001_initial.sql");

fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(sqliteFile);
const migration = fs.readFileSync(migrationFile, "utf8");
db.exec(migration);

const existing = db.prepare("SELECT value FROM app_state WHERE key = ?").get("db");
const syncJson = process.env.SQLITE_SYNC_JSON === "1";
if ((!existing || syncJson) && fs.existsSync(jsonFile)) {
  const raw = fs.readFileSync(jsonFile, "utf8");
  JSON.parse(raw);
  db.prepare(
    "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run("db", raw, new Date().toISOString());
}

console.log(
  JSON.stringify(
    {
      ok: true,
      sqliteFile,
      migratedFromJson: Boolean((!existing || syncJson) && fs.existsSync(jsonFile)),
      syncedJson: Boolean(syncJson && fs.existsSync(jsonFile)),
    },
    null,
    2,
  ),
);
