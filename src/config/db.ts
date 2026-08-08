import { MongoClient, Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI as string;

let client: MongoClient;
let db: Db;

export async function connectDB(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("music");

  console.log("✅ Mit MongoDB verbunden");
  return db;
}

export function getDB(): Db {
  if (!db) {
    throw new Error("Datenbank noch nicht verbunden. connectDB() zuerst aufrufen.");
  }
  return db;
}