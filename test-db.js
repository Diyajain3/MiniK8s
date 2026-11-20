import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

try {
  await client.connect();
  console.log("PostgreSQL connected successfully!");

  const result = await client.query('SELECT current_user, current_database()');
  console.log(result.rows);

} catch (error) {
  console.log("Connection failed:", error.message);
} finally {
  await client.end();
}