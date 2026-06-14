// MongoDB connection (native driver). Idempotent connect + collection accessors.
import { MongoClient } from 'mongodb';

let client = null;
let db = null;

export async function connectMongo() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(process.env.MONGODB_DATABASE || undefined);

  await ensureIndexes(db);
  console.log(`MongoDB connected: ${db.databaseName}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Mongo not connected — call connectMongo() first');
  return db;
}

export async function closeMongo() {
  if (client) await client.close();
  client = null;
  db = null;
}

async function ensureIndexes(database) {
  await database.collection('users').createIndex({ email: 1 }, { unique: true });
  // Magic tokens auto-expire via TTL on expiresAt.
  await database.collection('magic_tokens').createIndex({ token: 1 }, { unique: true });
  await database.collection('magic_tokens').createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
  );
}

// One place to reference collections so route code stays clean.
export const collections = {
  users: () => getDb().collection('users'),
  magicTokens: () => getDb().collection('magic_tokens'),
};
