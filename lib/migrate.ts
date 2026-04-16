/**
 * Migrate JSON chat/share files to SQLite.
 * Usage: npx tsx lib/migrate.ts
 */
import { migrateFromJson } from './chatStore';

async function main() {
  console.log('Migrating JSON files to SQLite...');
  const result = await migrateFromJson();
  console.log(`Done! Migrated ${result.chats} chats, ${result.shares} shares.`);
  console.log('Database: .data/chats.db');
  console.log('\nYou can now safely rename/delete .data/chats/ and .data/shares/ folders.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
