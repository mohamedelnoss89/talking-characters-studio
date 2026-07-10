// Quick verification: list users in the DB and confirm password is bcrypt-hashed
const Database = require("better-sqlite3");
const db = new Database("/home/z/my-project/data/auth.db", { readonly: true });
const users = db.prepare("SELECT id, username, display_name, password_hash, created_at FROM users").all();
console.log(`Found ${users.length} user(s):`);
for (const u of users) {
  const isBcrypt = u.password_hash && u.password_hash.startsWith("$2");
  console.log(`  #${u.id} | @${u.username} | display=${u.display_name || "(none)"} | bcrypt=${isBcrypt} | hash_len=${u.password_hash?.length} | created=${u.created_at}`);
}
db.close();
