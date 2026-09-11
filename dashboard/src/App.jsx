import React, { useState, useEffect, useRef, useMemo } from 'react';
import Header from './components/Header.jsx';
import ScoreChart from './components/ScoreChart.jsx';
import LayerBars from './components/LayerBars.jsx';
import ContextFlags from './components/ContextFlags.jsx';
import WaveformDisplay from './components/WaveformDisplay.jsx';
import CallLog from './components/CallLog.jsx';
import { supabase } from './supabaseClient.js';

const SCENARIOS = {
  high_value: {
    label: 'High-Value Transfer',
    escalate: 0.55,
    block: 0.80
  },
  retail: {
    label: 'Retail Banking',
    escalate: 0.65,
    block: 0.85
  },
  privileged: {
    label: 'Privileged Access',
    escalate: 0.45,
    block: 0.70
  }
};

export default function App() {
  const [selectedScenario, setSelectedScenario] = useState('high_value');
  const scenario = SCENARIOS[selectedScenario];

  // Streaming Live Data State (from WebSocket ws://localhost:8000/ws)
  const [callId, setCallId] = useState('demo1');
  const [elapsed, setElapsed] = useState(0);
  const [score, setScore] = useState(null);
  const [layers, setLayers] = useState({ acoustic: null, prosody: null, speaker: null });
  const [contextFlags, setContextFlags] = useState([]);
  const [history, setHistory] = useState([]);
  const [flagHistory, setFlagHistory] = useState([]);

  // Connection states
  const [wsConnected, setWsConnected] = useState(false);
  const [supabaseConnected, setSupabaseConnected] = useState(false);

  // Supabase Realtime Audit Data
  const [auditEvents, setAuditEvents] = useState([]);
  const [auditScorePoints, setAuditScorePoints] = useState([]);

  const wsRef = useRef(null);
  const seenFlagsRef = useRef(new Set());

  // Determine State based on live scenario thresholds
  const computedState = useMemo(() => {
    if (score === null || score === undefined) return 'OK';
    if (score >= scenario.block) return 'BLOCK';
    if (score >= scenario.escalate) return 'ESCALATE';
    return 'OK';
  }, [score, scenario]);

  const isAlert = score !== null && score !== undefined && score >= scenario.escalate;

  // 1. Establish WebSocket Connection to ws://localhost:8000/ws
  useEffect(() => {
    let reconnectTimeout = null;
    let isSubscribed = true;

    const connectWebSocket = () => {
      try {
        const ws = new WebSocket('ws://localhost:8000/ws');
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isSubscribed) return;
          console.log('[WebSocket] Connected to ws://localhost:8000/ws');
          setWsConnected(true);
        };

        ws.onmessage = (event) => {
          if (!isSubscribed) return;
          try {
            const data = JSON.parse(event.data);
            // Expected JSON: { call_id, t, score, layers: { acoustic, prosody, speaker }, context_flags, state }
            const currentT = Number(data.t || 0);
            const currentScore =
              data.score === null || data.score === undefined ? null : Number(data.score);

            setCallId(data.call_id || 'demo1');
            setElapsed(currentT);
            setScore(currentScore);

            if (data.layers) {
              setLayers({
                acoustic:
                  data.layers.acoustic === null || data.layers.acoustic === undefined
                    ? null
                    : Number(data.layers.acoustic),
                prosody:
                  data.layers.prosody === null || data.layers.prosody === undefined
                    ? null
                    : Number(data.layers.prosody),
                speaker:
                  data.layers.speaker === null || data.layers.speaker === undefined
                    ? null
                    : Number(data.layers.speaker)
              });
            }

            const incomingFlags = Array.isArray(data.context_flags) ? data.context_flags : [];
            setContextFlags(incomingFlags);

            // Record any newly observed context flags
            incomingFlags.forEach((flag) => {
              if (!seenFlagsRef.current.has(flag)) {
                seenFlagsRef.current.add(flag);
                setFlagHistory((prev) => [{ flag, t: currentT }, ...prev]);
              }
            });

            // Append to time-series history (null score represents pre-roll or gaps)
            setHistory((prev) => {
              const updated = [...prev, { t: currentT, score: currentScore }];
              // Keep last 100 points for smooth rendering
              return updated.length > 100 ? updated.slice(updated.length - 100) : updated;
            });
          } catch (err) {
            console.error('[WebSocket] Failed to parse message:', err);
          }
        };

        ws.onclose = () => {
          if (!isSubscribed) return;
          console.warn('[WebSocket] Disconnected. Retrying in 1.5s...');
          setWsConnected(false);
          reconnectTimeout = setTimeout(connectWebSocket, 1500);
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch (err) {
        console.error('[WebSocket] Connection attempt error:', err);
        reconnectTimeout = setTimeout(connectWebSocket, 1500);
      }
    };

    connectWebSocket();

    return () => {
      isSubscribed = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // 2. Supabase Realtime Subscriptions
  useEffect(() => {
    if (!supabase) {
      console.warn('[Supabase] Client not initialized (missing environment keys).');
      return;
    }

    const channel = supabase.channel('dashboard-realtime-channel');

    channel
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'score_point' },
        (payload) => {
          if (payload.new) {
            setAuditScorePoints((prev) => [payload.new, ...prev.slice(0, 30)]);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'threshold_event' },
        (payload) => {
          if (payload.new) {
            setAuditEvents((prev) => [payload.new, ...prev.slice(0, 30)]);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[Supabase Realtime] Subscribed to score_point & threshold_event');
          setSupabaseConnected(true);
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          setSupabaseConnected(false);
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg)' }}>
      {/* Header with timer, codec, scenario dropdown */}
      <Header
        elapsed={elapsed}
        callId={callId}
        codec="G.711 µ-law 8 kHz"
        wsConnected={wsConnected}
        supabaseConnected={supabaseConnected}
        scenario={selectedScenario}
        onScenarioChange={setSelectedScenario}
        scenarios={SCENARIOS}
      />

      {/* Main Monitoring Dashboard Grid */}
      <main style={{
        flex: 1,
        padding: '24px',
        maxWidth: '1440px',
        margin: '0 auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Top Split: Dominant Chart & Right Context Flags Panel */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)',
          gap: '20px',
          alignItems: 'stretch'
        }}>
          {/* Left Column: Dominant Score Line Chart */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <ScoreChart
              score={score}
              history={history}
              escalateThreshold={scenario.escalate}
              blockThreshold={scenario.block}
              state={computedState}
            />

            {/* Three Layer Contribution Bars directly beneath chart */}
            <LayerBars
              layers={layers}
              isAlert={isAlert}
            />
          </div>

          {/* Right Column: Context Flags Panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <ContextFlags
              activeFlags={contextFlags}
              flagHistory={flagHistory}
            />

            {/* Audio Ingest Waveform Display */}
            <WaveformDisplay isAlert={isAlert} />
          </div>
        </div>

        {/* Bottom Section: Supabase Realtime Audit Log */}
        <CallLog
          events={auditEvents}
          scorePoints={auditScorePoints}
        />
      </main>
    </div>
  );
}
