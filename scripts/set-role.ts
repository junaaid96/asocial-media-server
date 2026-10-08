// Promote someone to admin (or demote them) by username or email. No credentials live in code:
// sign up normally, then run this against the database.
//
//   npm run admin:promote -- <username-or-email>
//   npm run admin:demote  -- <username-or-email>
import pg from "pg";

const [, , action, identifier] = process.argv;
if (!["promote", "demote"].includes(action ?? "") || !identifier) {
  console.error("Usage: tsx scripts/set-role.ts promote|demote <username-or-email>");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const role = action === "promote" ? "admin" : "user";
  const { rows } = await client.query<{ username: string; role: string }>(
    "UPDATE users SET role = $2 WHERE lower(email) = lower($1) OR username = lower($1) RETURNING username, role",
    [identifier.replace(/^@/, ""), role],
  );
  if (!rows.length) {
    console.error(`No account matches "${identifier}".`);
    process.exitCode = 1;
  } else {
    console.log(`@${rows[0]!.username} is now ${rows[0]!.role === "admin" ? "an admin" : "a regular member"}.`);
  }
} finally {
  await client.end();
}
