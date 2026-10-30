import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/app.db', { readOnly: true });
for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name).join(', ');
  const n = db.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get().c;
  console.log(`${t.name} (${n} rows)\n    ${cols}`);
}
db.close();
