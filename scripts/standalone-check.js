const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");

function nodeVersionOk() {
  const [major] = process.versions.node.split(".").map(Number);
  return Number.isFinite(major) && major >= 18;
}

function checkWriteAccess() {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, ".standalone-write-test");
  fs.writeFileSync(probe, String(Date.now()));
  fs.unlinkSync(probe);
  return true;
}

function envValue(key, fallback = "") {
  return String(process.env[key] || fallback).trim();
}

function line(ok, label, detail) {
  const mark = ok ? "[OK]" : "[FAIL]";
  console.log(`${mark} ${label}${detail ? ` - ${detail}` : ""}`);
}

const checks = [];

checks.push({
  ok: nodeVersionOk(),
  label: "Node.js 18+",
  detail: `current ${process.versions.node}`,
});

let writable = false;
try {
  writable = checkWriteAccess();
} catch (error) {
  checks.push({
    ok: false,
    label: "data directory writable",
    detail: error.message,
  });
}
if (writable) {
  checks.push({
    ok: true,
    label: "data directory writable",
    detail: dataDir,
  });
}

checks.push({
  ok: true,
  label: "storage",
  detail: `${envValue("STORAGE_DRIVER", "sqlite")} at ${envValue("SQLITE_FILE", path.join(dataDir, "itera.sqlite"))}`,
});

checks.push({
  ok: true,
  label: "server URL",
  detail: `http://${envValue("HOST", "127.0.0.1")}:${envValue("PORT", "8787")}`,
});

console.log("Itera AI standalone preflight");
console.log("--------------------------------");
checks.forEach((item) => line(item.ok, item.label, item.detail));

const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error("");
  console.error("Standalone preflight failed. Fix the failed item above, then run start-standalone.bat again.");
  process.exit(1);
}

console.log("");
console.log("Standalone preflight passed.");
