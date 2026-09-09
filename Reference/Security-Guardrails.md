# Security & Ethics Guardrails (Internal Hackathon)

## Non-negotiable — breaking any of these loses the round

1. **Consent for cloned audio.** The cloned voice is a teammate who gave explicit consent. A slide states this *before* the audio plays.
2. **Never clone a judge, faculty member, or public figure.** Not as a surprise, not as a flourish. This turns an impressive demo into an uncomfortable one and can end your round.
3. **Enrolled voiceprints deleted after the demo.** Someone lent you their voice for one afternoon.
4. **Non-commercial licences respected.** In-the-Wild, XTTS-v2, F5-TTS are all non-commercial. Internal hackathon use is fine; one line on a slide beats being asked.
5. **No real customer data.** Placeholder amounts, fictional names on the approval screen.

## Graded response, not accusation
A false positive tells someone their genuine colleague is an impostor. The system therefore has two thresholds:
- **ESCALATE** — approval locks, call-back verification prompt shown
- **BLOCK** — transaction held and flagged

There is no state that says "this caller is a fraud." That framing is deliberate and it is the answer to the false-positive question.

## Privacy — one slide, not a pillar

We are not claiming an enterprise privacy posture and should not pretend to. What we can say truthfully in one line: raw audio is not persisted, only derived scores; and edge inference via the ONNX artifact is a documented option for a deployment that requires it. That is enough. Do not build the demo around it.

## Compliance — answer only if asked
Under India's DPDP Act, live call voice is personal data requiring consent, with purpose limitation and minimal retention. Whether derived acoustic features and speaker embeddings escape erasure obligations is **legally unsettled** — they are irreversible but still re-identifying. RBI's fraud-detection mandates and DPDP's consent requirement have **no settled resolution** for inline detection on unconsenting external callers.

Say "unsettled" where it is unsettled. A judge who knows this will respect the honesty far more than a confident wrong answer.

## Demo hygiene
Local inference only · own hotspot, never venue wifi · no real customer data, ever · placeholder amounts and fictional names on the approval screen
