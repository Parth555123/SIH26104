# System Architecture (Internal Hackathon)

## Flow

Two interchangeable audio sources feed one callback. The scorer cannot tell them apart.

```
[A] file_feeder.py  ◄── PRIMARY TODAY
    WAV → ffmpeg G.711 → 320 B chunks at wall-clock speed
[B] SIP phone ──► Asterisk ──► AudioSocket   ◄── LATER, OPTIONAL
                │
                ▼
        same callback interface   8 kHz slin16, 20 ms frames
                │
                ▼
        streaming_scorer.py     ring buffer → 1 s window / 0.5 s hop
                │               ** 8 kHz → 16 kHz upsample here **
                ├──► acoustic.py   AASIST (16 kHz raw waveform)
                ├──► prosody.py    F0 contour + pause/rhythm
                └──► speaker.py    ECAPA cosine vs enrolled ref
                │
                ▼
        fusion.py  → context_rules.py → EMA smoothing → thresholds
                │
                ▼
        api.py   FastAPI · WebSocket push · REST · OpenAPI /docs
                │
        ┌───────┴────────┐
   dashboard/       approval-ui/
```

## FROZEN API contract — do not modify after hour 1

```json
{
  "call_id": "c1",
  "t": 4.2,
  "score": 0.87,
  "layers": { "acoustic": 0.91, "prosody": 0.72, "speaker": 0.83 },
  "context_flags": ["unknown_origin", "high_value_txn"],
  "state": "OK|ESCALATE|BLOCK"
}
```

REST: `POST /session` opens a scored session · `GET /session/{id}/risk` returns current score · `GET /docs` OpenAPI.

## Critical constants
| Constant | Value | Note |
|---|---|---|
| AudioSocket port | 9092 | TCP, localhost |
| Wire format | 3 B header (type + BE length) + payload | Payload is **little-endian** |
| Audio frame | 0x10, 320 B, 20 ms | 8 kHz, 16-bit, mono |
| Model input | **16 kHz** raw waveform | Upsample required — top integration risk |
| Window / hop | 1.0 s / 0.5 s | Tune only if latency demands |
| Smoothing | EMA, α ≈ 0.3 | Raw scores flap and look broken |
| Fusion weights | acoustic 0.60 · speaker 0.25 · prosody 0.15 | Hand-set, justified, never learned |

## Layer notes forced by the research
- **Prosody:** jitter and shimmer are unreliable at 8 kHz — computed and displayed, **weighted 0** in fusion.
- **Speaker:** reference voiceprint must be enrolled **through the same codec path** as the live call. Wideband enrolment against narrowband live audio is the failure mode.
- **Dual output path:** local WebSocket carries the live score line (demo-critical, must survive a dead venue network). Supabase carries persistence, the call log, and approval-UI state via realtime subscriptions. Supabase writes are async and buffered — a slow insert must never stall the scorer loop.
- **Ingestion adapters:** PSTN/PBX built; VoIP trunk and collaboration-platform adapters are a boundary on the architecture slide, not code.
