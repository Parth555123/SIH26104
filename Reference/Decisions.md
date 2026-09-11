# Decisions.md

Append-only. Each entry: what, why, what it costs. Never delete an entry — a reversed decision gets a new entry.

---

**D1 — Enterprise/PBX deployment, not a phone app.**
The statement describes employees, executives and wire transfers. Android has blocked third-party in-call audio access since Android 10, so a Truecaller-style app cannot see PSTN call audio. The PBX is where the audio legally and technically lives.
*Cost:* no consumer story in the demo. Roadmap slide only.

**D2 — Published AASIST weights, no training.**
Training with codec augmentation is multi-day work. A half-trained detector is worse than none. Our contribution is the multi-layer fusion, the telephony pipeline, and honest evaluation.
*Cost:* must state this plainly and early, or it reads as a gap when caught.

**D3 — Three analysis layers, not one.**
The statement names multi-layer analysis as its first component and names single-layer detection as the existing failure. Three bars resolving into one score is also the most legible thing we can put on a dashboard.
*Cost:* ~5 extra hours. Cut prosody first if behind.

**D4 — Jitter and shimmer weighted 0.**
Research shows both are corrupted at 8 kHz by µ-law quantisation and jitter buffers. Including them would add noise while appearing rigorous.
*Cost:* a weaker prosody layer. Honest.

**D5 — Speaker reference enrolled through the codec path.**
Wideband enrolment against narrowband live audio is the documented failure mode; embeddings lose 3–5× EER on narrowband.
*Cost:* the enrolment step needs the codec pipeline working first.

**D6 — Hand-set fusion weights.**
No time and no validation data to learn them. Weights we can justify beat weights we cannot defend.
*Cost:* suboptimal fusion. Defensible.

**D7 — SQLite, no audio columns.** *(Reversed — see D11.)*

**D11 — Supabase Postgres, replacing SQLite.**
Realtime subscriptions remove the WebSocket fan-out we would otherwise hand-build, and the Supabase MCP lets an agent create the schema directly. Privacy is not a pillar of this demo — it's one honest line on one slide.
*Cost:* a network dependency. Mitigated by keeping the **local WebSocket as the primary path for the live score line**, with Supabase carrying persistence and the approval UI. If venue wifi dies, the score still moves.

**D8 — Light theme only.**
Projectors wash out dark themes; the score line must be readable from the back row. Also matches the banking surface we claim to integrate with.
*Cost:* none.

**D9 — AudioSocket over ChanSpy.**
AudioSocket normalises to fixed 8 kHz slin16 regardless of negotiated codec; ChanSpy inherits the codec and forces CPU-heavy transcoding, and needs an external trigger with race conditions.
*Cost:* if AudioSocket resists, ChanSpy is the documented fallback.

**D10 — Report cross-method and codec-degraded numbers on the main slide.**
Every other team will show one flattering figure. The gap is our credibility.
*Cost:* our headline number looks worse. That is the point.

**D12 — Rolling 4 s window, 0.5 s hop, padded to 64600 samples.**
AASIST has no fixed input length (`nb_samp` is a dataset-loader setting, not a model constraint), but it silently miscalibrates on short windows: measured ~2 pp score drift between a 1 s and a 4 s window, plus its eval-mode BatchNorm running stats were fitted on 4 s of context. Tiling a 1 s window up to 64600 produces yet another number with no guarantee it tracks the true 4 s score. Running at the published operating point (4.04 s ≈ 64600 samples) means the EER we measure describes the live system — and a confident-but-invalid score is the worst failure for a fraud detector. The 4 s buffer resamples 8→16 kHz to exactly 64000 samples; the 600-sample gap to `nb_samp` is closed by tiling, matching `clovaai/aasist data_utils.pad` (not zero-padding).
*Cost:* no score for the first ~4 s of a call — detection lands around 5 s instead of ~1 s. Acceptable: a social-engineering call runs a minute or more, so blocking at ~5 s is still mid-call. During pre-roll the scorer emits `score: null` / state `OK` ("listening") so the dashboard shows a waiting state, not a flat zero line.
