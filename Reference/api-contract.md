```json
{"call_id":"c1","t":4.2,"score":0.87,
 "layers":{"acoustic":0.91,"prosody":0.72,"speaker":0.83},
 "context_flags":["unknown_origin"],"state":"OK"}
```

Constants below it: WebSocket ws://localhost:8000/ws · states OK <0.55, ESCALATE 0.55–0.80, BLOCK >0.80 · audio in 8 kHz 16-bit mono 320-byte frames · model in 16 kHz, upsample happens in the scorer · window 1.0 s, hop 0.5 s, EMA alpha 0.3.
