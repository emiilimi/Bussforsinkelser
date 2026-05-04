/**
 * Last ned prod-DB fra R2 ved oppstart på Railway.
 * Brukes som del av start-kommandoen siden curl ikke er tilgjengelig.
 *
 * Env-variabler:
 *   DB_DOWNLOAD_URL  — public R2 URL til bussforsinkelser_prod.db
 *   DATABASE_PATH    — lokal sti å lagre til (default: /app/data/bussforsinkelser.db)
 */

import https from "https";
import http from "http";
import fs from "fs";
import path from "path";

const url = process.env.DB_DOWNLOAD_URL;
const dest = process.env.DATABASE_PATH ?? "/app/data/bussforsinkelser.db";

if (!url) {
  console.log("[download-db] DB_DOWNLOAD_URL ikke satt, hopper over.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });

console.log(`[download-db] Laster ned database fra R2 → ${dest} …`);

const client = url.startsWith("https") ? https : http;

client.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`[download-db] Feil: HTTP ${res.statusCode}`);
    process.exit(1);
  }

  const total = parseInt(res.headers["content-length"] ?? "0", 10);
  let received = 0;

  const file = fs.createWriteStream(dest);
  res.on("data", (chunk) => {
    received += chunk.length;
    if (total > 0) {
      const pct = ((received / total) * 100).toFixed(0);
      process.stdout.write(`\r[download-db] ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
    }
  });
  res.pipe(file);

  file.on("finish", () => {
    file.close();
    console.log(`\n[download-db] Ferdig (${(received / 1024 / 1024).toFixed(1)} MB)`);
  });

  file.on("error", (err) => {
    console.error("[download-db] Skrivefeil:", err);
    fs.unlink(dest, () => {});
    process.exit(1);
  });
}).on("error", (err) => {
  console.error("[download-db] Nettverksfeil:", err.message);
  process.exit(1);
});
