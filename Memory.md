# Memory.md — shared context for all agents

Paste this at the start of an agent session alongside `Rules.md`. Nothing else is shared context.

## What this is
A synthetic-voice detection service for enterprise telephony. Live call audio → fused risk score → a high-value transaction approval locks before the caller finishes speaking. Internal hackathon demo, single machine, two SIP extensions.

## Pipeline
Asterisk (G.711 µ-law) → AudioSocket TCP :9092 → ring buffer (1 s window, 0.5 s hop) → **upsample 8→16 kHz** → three layers → fusion → context rules → EMA smoothing → thresholds → WebSocket → dashboard + approval UI.

## The three layers
| Layer | Model | Weight |
|---|---|---|
| Acoustic | AASIST, published weights, 16 kHz raw waveform | 0.60 |
| Speaker | ECAPA-TDNN cosine vs enrolled reference | 0.25 |
| Prosody | F0 contour stats + pause/rhythm (parselmouth) | 0.15 |

Jitter/shimmer are computed and displayed but weighted **0** — unreliable at 8 kHz.

## Facts that constrain the code
- AudioSocket: 3-byte header (1 B type, 2 B **big-endian** length) + payload. Payload PCM is **little-endian**. Audio type `0x10`, 320 B, 20 ms, 8 kHz mono. Total 323 B per audio packet. TCP fragments — always `recvall` exactly N bytes.
- AASIST published: 0.83% EER on ASVspoof 2019 LA · 10.51% on 2021 LA · 21.07% on 2021 DF. Our measurements should land near these.
- Speaker embeddings lose 3–5× EER on narrowband. Enrol the reference **through the same codec path** as the live call.
- EER must be computed by interpolation (`scipy.optimize.brentq`), not `min(abs(fpr-fnr))`. Bona fide = positive class (1).

## States
`OK` → `ESCALATE` (approval locks, call-back prompt) → `BLOCK` (transaction held). There is no state that accuses the caller of fraud.

## Out of scope — do not build
Training · multi-tenancy · auth · scale · cloud · Android · gRPC · real SMS/email gateway · dark mode
