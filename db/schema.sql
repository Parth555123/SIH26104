-- SIH26104 Database Schema — Supabase Postgres

-- 1. call_session
CREATE TABLE IF NOT EXISTS call_session (
    call_id text PRIMARY KEY,
    started_at timestamptz DEFAULT now(),
    ended_at timestamptz NULL,
    codec text,
    origin_number text,
    enrolled_speaker text NULL,
    final_state text
);

-- 2. score_point (realtime on)
CREATE TABLE IF NOT EXISTS score_point (
    id bigserial PRIMARY KEY,
    call_id text REFERENCES call_session(call_id),
    t real NOT NULL,
    score real NOT NULL,
    acoustic real,
    prosody real,
    speaker real,
    context_flags jsonb DEFAULT '[]'::jsonb,
    state text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_score_point_call_id_t ON score_point (call_id, t);

-- 3. threshold_event (realtime on)
CREATE TABLE IF NOT EXISTS threshold_event (
    id bigserial PRIMARY KEY,
    call_id text REFERENCES call_session(call_id),
    t real NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    flags jsonb
);

-- 4. transaction_demo (realtime on)
CREATE TABLE IF NOT EXISTS transaction_demo (
    txn_id text PRIMARY KEY,
    call_id text REFERENCES call_session(call_id),
    amount bigint NOT NULL,
    state text NOT NULL,
    locked_at real NULL
);

-- Disable Row Level Security on all four tables (internal hackathon build)
ALTER TABLE call_session DISABLE ROW LEVEL SECURITY;
ALTER TABLE score_point DISABLE ROW LEVEL SECURITY;
ALTER TABLE threshold_event DISABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_demo DISABLE ROW LEVEL SECURITY;

-- Enable Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE score_point;
ALTER PUBLICATION supabase_realtime ADD TABLE threshold_event;
ALTER PUBLICATION supabase_realtime ADD TABLE transaction_demo;
