import pg from "pg";
import { databaseSslConfig } from "./ssl";

/**
 * This module sets up a connection pool to the PostgreSQL database using the `pg` library.
 * The connection configuration is sourced from the `DATABASE_URL` environment variable, and SSL is configured to reject unauthorized connections.
 * The pool instance is exported for use in other parts of the application to perform database queries.
 *
 * Environment variables:
 * - DATABASE_URL: The connection string for the PostgreSQL database (e.g., "postgresql://user:password@host:port/database").
 */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSslConfig(),
});

export default pool;
