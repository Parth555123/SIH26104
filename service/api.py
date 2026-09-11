"""FastAPI surface for the risk scorer.

    WS   /ws                    push the frozen score message (api-contract.md), nothing else
    POST /session               open a scored session against a WAV, start the feeder
    GET  /session/{id}/risk     latest score message for that session

Score points are buffered and flushed to Supabase every ~2 s on a background
task. A slow network insert never blocks the scorer loop or the WebSocket — the
local WS is the demo-critical path (Database-Schema.md).
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import threading
from contextlib import asynccontextmanager
from uuid import uuid4
from pathlib import Path
import sys

_svc_dir = Path(__file__).resolve().parent
if str(_svc_dir) not in sys.path:
    sys.path.insert(0, str(_svc_dir))

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import file_feeder
from streaming_scorer import StreamingScorer

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("api")

SUPABASE_URL = os.getenv("VITE_SUPABASE_URL") or os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("VITE_SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY")
PG_FLUSH_SECONDS = 2.0


def _listening_message(call_id: str) -> dict:
    """Pre-roll placeholder: score/layers null, state OK. Same shape the scorer
    emits until its 4 s window fills — the dashboard renders this as 'listening'."""
    return {
        "call_id": call_id,
        "t": 0.0,
        "score": None,
        "layers": {"acoustic": None, "prosody": None, "speaker": None},
        "context_flags": [],
        "state": "OK",
    }


def _score_row(m: dict) -> dict:
    return {
        "call_id": m["call_id"],
        "t": m["t"],
        "score": m["score"],
        "acoustic": m["layers"]["acoustic"],
        "prosody": m["layers"]["prosody"],
        "speaker": m["layers"]["speaker"],
        "context_flags": m["context_flags"],
        "state": m["state"],
    }


def _make_supabase():
    if not (SUPABASE_URL and SUPABASE_KEY):
        logger.warning("Supabase creds missing - persistence disabled, WS still live")
        return None
    try:
        from supabase import create_client

        return create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as exc:  # noqa: BLE001 - offline demo must still run
        logger.warning("Supabase init failed (%s) - persistence disabled", exc)
        return None


def _insert_session(sb, call_id: str, req: "SessionRequest") -> None:
    try:
        sb.table("call_session").insert({
            "call_id": call_id,
            "codec": "ulaw",
            "origin_number": req.origin_number,
            "final_state": "OK",
        }).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("call_session insert failed: %s", exc)


def _insert_transition(sb, evt: dict) -> None:
    try:
        sb.table("threshold_event").insert(evt).execute()
    except Exception as exc:  # noqa: BLE001 - network must never stall the demo
        logger.warning("threshold_event insert failed: %s", exc)


async def _fanout(app: FastAPI) -> None:
    """Drain the score queue: update latest, broadcast to WS clients, buffer for PG."""
    while True:
        msg = await app.state.queue.get()
        app.state.latest[msg["call_id"]] = msg
        if msg["score"] is not None:            # don't persist pre-roll "listening" rows
            app.state.pg_buf.append(msg)
        for ws in list(app.state.clients):
            try:
                await ws.send_json(msg)
            except Exception:  # noqa: BLE001 - drop dead sockets, keep the loop alive
                app.state.clients.discard(ws)


async def _pg_flush(app: FastAPI) -> None:
    """Flush buffered score points to Supabase every ~2 s, off the event loop."""
    while True:
        await asyncio.sleep(PG_FLUSH_SECONDS)
        if not (app.state.sb and app.state.pg_buf):
            continue
        rows = [_score_row(m) for m in app.state.pg_buf]
        app.state.pg_buf.clear()
        try:
            await asyncio.to_thread(
                lambda: app.state.sb.table("score_point").insert(rows).execute()
            )
        except Exception as exc:  # noqa: BLE001 - network must never stall the demo
            logger.warning("score_point flush of %d rows failed: %s", len(rows), exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.loop = asyncio.get_running_loop()
    app.state.clients = set()
    app.state.latest = {}
    app.state.queue = asyncio.Queue()
    app.state.pg_buf = []
    app.state.sb = _make_supabase()
    tasks = [asyncio.create_task(_fanout(app)), asyncio.create_task(_pg_flush(app))]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(lifespan=lifespan)


def _emit(msg: dict) -> None:
    """Called from the feeder/scorer thread — hand the message to the event loop."""
    app.state.loop.call_soon_threadsafe(app.state.queue.put_nowait, msg)


def _emit_transition(evt: dict) -> None:
    """Scorer-thread state transition — persist threshold_event off the loop."""
    def schedule() -> None:
        if app.state.sb:
            asyncio.create_task(asyncio.to_thread(_insert_transition, app.state.sb, evt))

    app.state.loop.call_soon_threadsafe(schedule)


class SessionRequest(BaseModel):
    wav_path: str
    call_id: str | None = None
    origin_number: str | None = None
    started_at: str | None = None     # ISO 8601 call start; default = now
    amount: int | None = None         # transaction value (rupees), drives high_value_txn


@app.post("/session")
async def create_session(req: SessionRequest) -> dict:
    call_id = req.call_id or f"feeder-{uuid4().hex[:8]}"
    # context_rules.evaluate() reads these; flags + adjustment are derived per window.
    metadata = {
        "origin_number": req.origin_number,
        "started_at": req.started_at or datetime.datetime.now().isoformat(),
        "amount": req.amount,
    }
    scorer = StreamingScorer(call_id, _emit, on_transition=_emit_transition,
                             metadata=metadata)
    app.state.latest.setdefault(call_id, _listening_message(call_id))
    # await the parent row: threshold_event / score_point FK it, and the first
    # transition can land ~1 s after this returns.
    if app.state.sb:
        await asyncio.to_thread(_insert_session, app.state.sb, call_id, req)
    wav_file = Path(req.wav_path)
    if not wav_file.is_file():
        alt = Path(__file__).resolve().parent.parent / req.wav_path
        if alt.is_file():
            wav_file = alt

    threading.Thread(
        target=file_feeder.feed, args=(wav_file, scorer.feed), daemon=True
    ).start()
    return {"call_id": call_id}


@app.get("/session/{call_id}/risk")
async def get_risk(call_id: str) -> dict:
    return app.state.latest.get(call_id) or _listening_message(call_id)


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    app.state.clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()  # ignore client input; keeps the socket open
    except WebSocketDisconnect:
        pass
    finally:
        app.state.clients.discard(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
