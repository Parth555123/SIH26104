# Voice Cloning Impersonation Detection

Real-time synthetic-speech detection for enterprise telephony. Live call audio streams in through a real PSTN codec, a rolling risk score updates every half second, and a high-value transaction approval locks before the caller finishes speaking.

Built for **SIH26104** (AICTE) — AI-Powered Real-Time Detection and Prevention of Voice Cloning Impersonation Attacks.

> **Status: working prototype.** The pipeline is complete and verified end to end. The acoustic layer runs published AASIST weights; the prosody and speaker-consistency layers are interfaced but not yet implemented. No model was trained for this project — see [Honest limitations](#honest-limitations).

---

## The problem

A few seconds of recorded voice is enough to clone it convincingly. Attackers phone employees impersonating executives and authorise fraudulent transfers — $25M from an engineering firm in Hong Kong in 2024, ₹17 lakh from a finance company in Bengaluru the same year.

Caller ID doesn't help: SS7 has no cryptographic origin authentication. Human recognition doesn't help either — telephony compression strips the high-frequency artifacts that might betray a clone before the audio reaches the handset.

Detection has to happen inside the call, in time to stop the transaction.

---

## Architecture

```
[A] file_feeder.py                 [B] audiosocket_server.py
    WAV → ffmpeg G.711 →               Asterisk AudioSocket (TCP :9092)
    320 B chunks @ wall-clock          20 ms frames, 8 kHz slin16
                    │                          │
                    └──────────┬───────────────┘
                               ▼
                    identical callback interface
                               │
                    streaming_scorer.py
                    4 s ring buffer · 0.5 s hop
                    8 kHz → 16 kHz → pad to 64600
                               │
              ┌────────────────┼────────────────┐
         acoustic          prosody          speaker
      AASIST (live)      (interfaced)     (interfaced)
              └────────────────┼────────────────┘
                               ▼
                      fusion (renormalised
                      over live layers only)
                               │
                    EMA smoothing (α 0.3)
                               │
                    + context_rules adjustment
                               │
                      thresholds → state
                               │
              ┌────────────────┴────────────────┐
       local WebSocket                    Supabase
    (live score line —              buffered async writes,
     never network-bound)            realtime subscriptions
              │                              │
         dashboard/              audit log · approval-ui/
```

The two audio sources expose the same callback signature, so the scorer cannot distinguish a live call from a file. Moving from the file feeder to a real PBX is one line in an Asterisk dialplan.

---

## What it does

- **Streams through a real codec.** Audio is transcoded through G.711 µ-law before scoring, so the detector sees the same quantisation loss a phone call carries.
- **Scores a rolling window.** 4 seconds at 0.5 s hop, resampled 8→16 kHz and padded to AASIST's `nb_samp` of 64600 — matching the protocol its published EER was measured on.
- **Refuses to guess.** Before the buffer fills, the system emits `score: null` and a listening state rather than a misleading zero.
- **Fuses multiple evidence types.** Acoustic, prosody, and speaker-consistency layers with hand-set weights. Fusion renormalises over whichever layers are live, so unbuilt layers don't dilute the score.
- **Enriches with context.** Unknown origin, first contact, off-hours, high transaction value — applied as a per-call constant after smoothing.
- **Escalates rather than accuses.** Two thresholds: `ESCALATE` locks the approval and demands call-back verification; `BLOCK` holds and flags the transaction. There is no state that calls someone a fraud.
- **Keeps the demo path local.** The live score line runs over a local WebSocket. Database writes are buffered and asynchronous, so a slow insert can never stall the scorer.

---

## Stack

| Layer | Choice |
|---|---|
| Acoustic model | [AASIST](https://github.com/clovaai/aasist) (MIT), published weights |
| Telephony | Asterisk + AudioSocket · ffmpeg G.711 / GSM / AMR-NB / Opus |
| Service | FastAPI · WebSocket · OpenAPI at `/docs` |
| Store | Supabase Postgres with realtime subscriptions |
| Frontend | React + Vite, light theme, wavesurfer.js |
| Analysis | MATLAB — spectral artifact figures, DET curves |

Runs natively on Windows. No WSL required.

---

## Running it

**Requirements:** Python 3.12, Node 20, ffmpeg with `libgsm` and `pcm_mulaw`, a Supabase project.

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Clone AASIST and its weights:

```powershell
git clone https://github.com/clovaai/aasist.git
```

Create `.env` from `.env.example` with your Supabase URL and anon key, then apply `db/schema.sql` to your project.

**Start the service:**

```powershell
cd service
py -m uvicorn api:app --port 8000
```

**Start the surfaces:**

```powershell
cd dashboard && npm run dev        # :5173
cd approval-ui && npm run dev      # :5174
```

**Run a session:**

```powershell
Invoke-RestMethod -Uri http://localhost:8000/session -Method Post `
  -ContentType "application/json" `
  -Body '{"wav_path":"C:/path/to/audio.wav","origin_number":"anonymous","started_at":"2026-09-11T23:30:00","amount":4000000}'
```

**Batch inference on a directory:**

```powershell
py eval\run_inference.py --checkpoint aasist\models\weights\AASIST.pth `
  --input_dir demo --output_csv eval\scores.csv --aasist_root aasist
py eval\compute_eer.py --csv eval\scores.csv
```

---

## Message contract

Frozen. Every WebSocket message carries exactly these six keys:

```json
{
  "call_id": "c1",
  "t": 4.2,
  "score": 0.87,
  "layers": { "acoustic": 0.91, "prosody": null, "speaker": null },
  "context_flags": ["unknown_origin", "off_hours"],
  "state": "OK"
}
```

`score` and layer values are `null` during the pre-roll listening period and for layers not yet implemented. States: `OK` below 0.55 · `ESCALATE` 0.55–0.80 · `BLOCK` above 0.80.

Score polarity throughout: **spoof is the positive class**, `score = P(spoof)`, higher means more synthetic.

---

## Honest limitations

We report these because they are the interesting part.

**We did not train a model.** The acoustic layer runs AASIST's published weights, trained on ASVspoof 2019 LA. Our contribution is the telephony pipeline, the multi-layer fusion architecture, and the evaluation below.

**Two of three layers are unbuilt.** Prosody and speaker consistency are interfaced and the fusion handles their absence correctly — they render as `—` rather than a fabricated number.

**AASIST partly detects bandwidth, not synthesis.** We measured this on our own recordings:

| File | HF fraction (4–8 kHz) | P(spoof) |
|---|---|---|
| Clean studio speech (genuine) | 0.086 | 0.000015 |
| Mobile-recorded speech (genuine) | 0.0006 | 0.999 |
| XTTS-v2 clone (synthetic) | 0.015 | 0.516 |

A genuine recording captured through a band-limited mobile path scores as maximally synthetic, while a full-band clone scores lower. In ASVspoof 2019, degraded high frequencies correlated with spoofed audio — so the model learned bandwidth as a shortcut. On a real phone line that correlation breaks.

This is the shortcut-learning failure documented in the ASVspoof 2021 literature, reproduced on our own audio.

**Telephony codecs compound it.** Pushing audio through G.711 µ-law shifts scores up by roughly 0.15 independently of content, because the 4 kHz bandpass deletes the upper spectrum entirely.

**Published cross-domain degradation, for reference:**

| Model | Train | Eval | EER |
|---|---|---|---|
| AASIST | 2019 LA | 2019 LA | 0.83% |
| AASIST | 2019 LA | 2021 LA (codec) | 10.51% |
| AASIST | 2019 LA | 2021 DF | 21.07% |

Detectors that score beautifully on clean audio collapse on telephony. Telephony is where the attack happens.

---

## Next

1. **Codec-augmented retraining** via [RawBoost](https://arxiv.org/abs/2111.04433) — published ~39% relative EER reduction on cross-domain data.
2. **wav2vec2 / WavLM front-end** instead of raw waveform, which separates channel effects from phonetic content and is the current best answer to generalisation.
3. **Prosody and speaker layers** — interfaces are in place.
4. **Live Asterisk integration** — the AudioSocket server is built and tested; it needs a dialplan and a Linux host.
5. **Indian-language evaluation** using IndicSynth and SEA-Spoof.

---

## Ethics

Any cloned audio used in demonstrations comes from a consenting speaker who was told how it would be used, and enrolled voiceprints are deleted afterwards. Datasets and cloning tools used here (In-the-Wild, XTTS-v2, F5-TTS) carry non-commercial licences and are used accordingly.

This is a defensive system. It escalates to human verification; it does not make accusations.

---

## Licence

Code in this repository: MIT. AASIST weights are MIT from the [original repository](https://github.com/clovaai/aasist). Datasets and cloning tools retain their own licences.
