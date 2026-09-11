"""Simple WebSocket risk-score emitter for the local dashboard demo."""

import asyncio
import random
import time

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect


app = FastAPI()


def clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


@app.websocket("/ws")
async def emit_scores(websocket: WebSocket) -> None:
    await websocket.accept()
    connected_at = time.monotonic()

    try:
        while True:
            elapsed = time.monotonic() - connected_at
            if elapsed < 20.0:
                progress = elapsed / 20.0
                base_score = 0.10 + (0.92 - 0.10) * progress
                score = clamp(base_score + random.uniform(-0.015, 0.015))
            else:
                score = 0.92

            state = "OK"
            if score > 0.80:
                state = "BLOCK"
            elif score >= 0.55:
                state = "ESCALATE"

            await websocket.send_json(
                {
                    "call_id": "demo1",
                    "t": round(elapsed, 3),
                    "score": round(score, 3),
                    "layers": {
                        "acoustic": round(clamp(score + random.uniform(-0.05, 0.05)), 3),
                        "prosody": round(clamp(score + random.uniform(-0.08, 0.08)), 3),
                        "speaker": round(clamp(score + random.uniform(-0.06, 0.06)), 3),
                    },
                    "context_flags": ["unknown_origin"] if elapsed > 3.0 else [],
                    "state": state,
                }
            )
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
