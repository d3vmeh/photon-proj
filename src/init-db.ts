import { openDb } from "./db.js";

const db = openDb();
console.log("DB ready at", process.env.RECEIPTS_DB || "./receipts.db");
db.close();
