-- Runs once, when the postgres volume is first created.
--
-- Extensions our migrations rely on, plus the `auth` schema. nhost's managed
-- Postgres ships with both; the plain postgres image does not, and hasura-auth
-- refuses to run its own migrations if the schema is missing.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS auth;
