# Database Schema — Supabase Postgres

Hosted Supabase. Realtime enabled on `score_point` and `transaction_demo` so the dashboard and approval UI subscribe directly instead of us building WebSocket fan-out.

Project ref: `hdwivjtrzuymjwxggvsf`

## Tables

### `call_session`
| Column | Type | Note |
|---|---|---|
| call_id | text PK | AudioSocket UUID or feeder-generated |
| started_at | timestamptz default now() | |
| ended_at | timestamptz null | |
| codec | text | `ulaw` / `gsm` |
| origin_number | text | drives context rules |
| enrolled_speaker | text null | |
| final_state | text | `OK` / `ESCALATE` / `BLOCK` |

### `score_point` — **realtime on**
| Column | Type |
|---|---|
| id | bigserial PK |
| call_id | text FK → call_session |
| t | real (seconds since call start) |
| score | real (fused) |
| acoustic, prosody, speaker | real |
| context_flags | jsonb default '[]' |
| state | text |

Index on `(call_id, t)`.

### `threshold_event` — **realtime on**
| Column | Type |
|---|---|
| id | bigserial PK |
| call_id | text FK |
| t | real |
| from_state, to_state | text |
| flags | jsonb |

### `transaction_demo` — **realtime on**
| Column | Type |
|---|---|
| txn_id | text PK |
| call_id | text FK |
| amount | bigint |
| state | text — `PENDING` / `APPROVED` / `HELD` |
| locked_at | real null |

## RLS
Disable RLS on all four tables for the hackathon, or use a single permissive policy. Auth is out of scope and RLS misconfiguration is a classic way to lose two hours to silent empty result sets.

## Write pattern — this matters for latency
The scorer emits every 0.5 s. **Do not insert one row per emission over the network in the demo path.** Buffer locally and flush every ~2 s, or insert asynchronously so a slow network never stalls the scorer loop.

The **local WebSocket stays the primary path for the live score line** — it is what the time-to-detection number depends on, and it must not be hostage to venue wifi. Supabase carries persistence, the call log, and the approval UI state. If the network dies on stage, the score line keeps moving.
