# Design System (Internal Hackathon)

**Light theme only. No dark mode. No toggle.** Projectors wash out dark backgrounds; a thin coloured score line on dark is unreadable from the back of a hall. Light also matches the banking approval surface we claim to integrate with.

## Tokens
```css
--bg:            #FAFAF8;   /* off-white, not pure white — reads better under projector */
--surface:       #FFFFFF;
--border:        #E4E2DD;
--text:          #1C1B19;
--text-muted:    #6B6862;
--line-neutral:  #8A8680;   /* the score line at rest */
--alert:         #C2410C;   /* ONLY threshold crossings and blocked states */
--threshold:     #C9C5BE;   /* dashed rules */
```

## Colour discipline
- Everything neutral grey by default.
- **One** alert colour, used only when a threshold is crossed or a transaction is held.
- **Never colour the safe state green.** If green is already on screen, the alert loses its punch when it finally fires. This is the single most common mistake and it costs the demo its moment.

## Type
System stack. Score readout at 64px+ — it must be legible from the back row. Labels 13–14px, muted. Nothing decorative.

## Layout — monitoring dashboard
1. Score line, dominant, top half. Two dashed threshold rules.
2. Three layer contribution bars beneath: acoustic · prosody · speaker.
3. Context flags panel, right — each rule appears as it fires.
4. Elapsed timer + active codec label, header.
5. Scenario dropdown (retail / high-value transfer / privileged access) — changes thresholds live.

## Layout — approval surface
Bank-internal styling. Pending ₹40,00,000 transfer, Approve button. On ESCALATE the button locks and a call-back verification prompt replaces it. Timestamp of the state change visible.

## Deck
Same light theme, same accent colour, so the cut from slides to live demo isn't jarring.
