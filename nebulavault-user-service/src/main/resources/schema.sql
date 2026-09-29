create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  auth_sub text not null unique,
  email    text not null unique,
  name     text,
  avatar_url text,
  plan text not null default 'STARTER',
  quota_bytes bigint not null default 104_857_600,
  used_bytes  bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists account_deletion_tombstones (
  auth_sub text primary key,
  created_at timestamptz not null default now()
);
