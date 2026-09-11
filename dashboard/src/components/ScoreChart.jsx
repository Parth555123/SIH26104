import React, { useMemo } from 'react';

export default function ScoreChart({
  score = null,
  history = [],
  escalateThreshold = 0.55,
  blockThreshold = 0.80,
  state = 'OK'
}) {
  const isListening = score === null || score === undefined || isNaN(score);
  const isAlert = !isListening && score >= escalateThreshold;

  // Chart dimensions
  const svgWidth = 850;
  const svgHeight = 260;
  const padding = { top: 20, right: 90, bottom: 30, left: 45 };

  const plotWidth = svgWidth - padding.left - padding.right;
  const plotHeight = svgHeight - padding.top - padding.bottom;

  // Compute continuous runs of non-null points (score === null treated as a gap)
  const runs = useMemo(() => {
    if (!history || history.length === 0) return [];

    // X scale: based on elapsed time across all history points
    const minT = history[0]?.t || 0;
    const maxT = Math.max(minT + 10, history[history.length - 1]?.t || 10);
    const rangeT = maxT - minT || 1;

    const result = [];
    let currentRun = [];

    history.forEach((pt) => {
      if (pt.score !== null && pt.score !== undefined && !isNaN(pt.score)) {
        const x = padding.left + ((pt.t - minT) / rangeT) * plotWidth;
        const y = padding.top + plotHeight - Math.max(0, Math.min(1, pt.score)) * plotHeight;
        currentRun.push({ x, y, score: pt.score, t: pt.t });
      } else {
        if (currentRun.length > 0) {
          result.push(currentRun);
          currentRun = [];
        }
      }
    });

    if (currentRun.length > 0) {
      result.push(currentRun);
    }

    return result;
  }, [history, plotWidth, plotHeight, padding.left, padding.top]);

  // Construct SVG path strings for each continuous run
  const runPaths = useMemo(() => {
    return runs.map((run) => {
      return run.reduce((acc, pt, idx) => {
        return idx === 0
          ? `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`
          : `${acc} L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
      }, '');
    });
  }, [runs]);

  // Area under line for each continuous run
  const areaPaths = useMemo(() => {
    const bottomY = padding.top + plotHeight;
    return runs.map((run, idx) => {
      if (run.length < 2) return '';
      const pathD = runPaths[idx];
      const first = run[0];
      const last = run[run.length - 1];
      return `${pathD} L ${last.x.toFixed(1)} ${bottomY} L ${first.x.toFixed(1)} ${bottomY} Z`;
    });
  }, [runs, runPaths, padding.top, plotHeight]);

  // Alert overlay segments for sections at or above ESCALATE
  const alertSegments = useMemo(() => {
    const segments = [];
    runs.forEach((run) => {
      for (let index = 1; index < run.length; index += 1) {
        const previous = run[index - 1];
        const current = run[index];
        const previousAlert = previous.score >= escalateThreshold;
        const currentAlert = current.score >= escalateThreshold;

        if (!previousAlert && !currentAlert) continue;
        if (previousAlert && currentAlert) {
          segments.push(
            `M ${previous.x.toFixed(1)} ${previous.y.toFixed(1)} L ${current.x.toFixed(1)} ${current.y.toFixed(1)}`
          );
          continue;
        }

        const ratio = (escalateThreshold - previous.score) / (current.score - previous.score);
        const crossing = {
          x: previous.x + (current.x - previous.x) * ratio,
          y: previous.y + (current.y - previous.y) * ratio
        };
        const start = previousAlert ? previous : crossing;
        const end = currentAlert ? current : crossing;
        segments.push(
          `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`
        );
      }
    });
    return segments;
  }, [runs, escalateThreshold]);

  // Cursor for current active point (only when active score is not null)
  const currentPoint = useMemo(() => {
    if (isListening || runs.length === 0) return null;
    const lastRun = runs[runs.length - 1];
    if (lastRun.length === 0) return null;
    return lastRun[lastRun.length - 1];
  }, [runs, isListening]);

  // Y coordinate for thresholds
  const escalateY = padding.top + plotHeight - escalateThreshold * plotHeight;
  const blockY = padding.top + plotHeight - blockThreshold * plotHeight;

  return (
    <div style={{
      backgroundColor: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      padding: '24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px'
    }}>
      {/* Top Bar: Numeric / Listening Readout & State Pill */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '20px' }}>
          <div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Fused Synthetic Risk Score
            </div>
            {/* Readout: 72px numeric score or 52px "Listening…" pre-roll */}
            <div style={{
              fontSize: isListening ? '52px' : '72px',
              fontWeight: 800,
              fontFamily: isListening ? 'var(--font-system)' : 'var(--font-mono)',
              lineHeight: 1,
              letterSpacing: isListening ? '-0.02em' : '-0.03em',
              color: isAlert ? 'var(--alert)' : isListening ? 'var(--text-muted)' : 'var(--text)'
            }}>
              {isListening ? 'Listening…' : score.toFixed(3)}
            </div>
          </div>

          {/* State Badge: neutral when OK, alert ONLY on threshold crossing. NEVER green. */}
          <div style={{
            padding: '6px 16px',
            borderRadius: '4px',
            fontSize: '15px',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            backgroundColor: isAlert ? 'var(--alert)' : 'var(--border)',
            color: isAlert ? '#FFFFFF' : 'var(--text)'
          }}>
            {state}
          </div>
        </div>

        {/* Threshold Reference indicators */}
        <div style={{ display: 'flex', gap: '16px', fontSize: '13px', color: 'var(--text-muted)' }}>
          <div>
            <span style={{ display: 'inline-block', width: '12px', height: '2px', backgroundColor: 'var(--threshold)', verticalAlign: 'middle', marginRight: '6px', borderTop: '1px dashed var(--line-neutral)' }} />
            Escalate: <strong style={{ color: 'var(--text)' }}>{escalateThreshold.toFixed(2)}</strong>
          </div>
          <div>
            <span style={{ display: 'inline-block', width: '12px', height: '2px', backgroundColor: 'var(--threshold)', verticalAlign: 'middle', marginRight: '6px', borderTop: '1px dashed var(--line-neutral)' }} />
            Block: <strong style={{ color: 'var(--text)' }}>{blockThreshold.toFixed(2)}</strong>
          </div>
        </div>
      </div>

      {/* SVG Dominant Score Line Chart */}
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
        >
          {/* Y Axis Grid lines (0.0, 0.25, 0.5, 0.75, 1.0) */}
          {[0, 0.25, 0.5, 0.75, 1.0].map((val) => {
            const y = padding.top + plotHeight - val * plotHeight;
            return (
              <g key={val}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={padding.left + plotWidth}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth="1"
                />
                <text
                  x={padding.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="11"
                  fill="var(--text-muted)"
                  fontFamily="var(--font-mono)"
                >
                  {val.toFixed(2)}
                </text>
              </g>
            );
          })}

          {/* Threshold 1: ESCALATE (Dashed line) */}
          <line
            x1={padding.left}
            y1={escalateY}
            x2={padding.left + plotWidth}
            y2={escalateY}
            stroke="var(--line-neutral)"
            strokeWidth="1.5"
            strokeDasharray="6,4"
          />
          <text
            x={padding.left + plotWidth + 8}
            y={escalateY + 4}
            fontSize="11"
            fontWeight="600"
            fill={isAlert ? 'var(--alert)' : 'var(--text-muted)'}
            fontFamily="var(--font-system)"
          >
            ESCALATE {escalateThreshold.toFixed(2)}
          </text>

          {/* Threshold 2: BLOCK (Dashed line) */}
          <line
            x1={padding.left}
            y1={blockY}
            x2={padding.left + plotWidth}
            y2={blockY}
            stroke="var(--line-neutral)"
            strokeWidth="1.5"
            strokeDasharray="6,4"
          />
          <text
            x={padding.left + plotWidth + 8}
            y={blockY + 4}
            fontSize="11"
            fontWeight="600"
            fill={!isListening && score >= blockThreshold ? 'var(--alert)' : 'var(--text-muted)'}
            fontFamily="var(--font-system)"
          >
            BLOCK {blockThreshold.toFixed(2)}
          </text>

          {/* Fill under line for each continuous run */}
          {areaPaths.map((areaD, idx) =>
            areaD ? (
              <path
                key={`area-${idx}`}
                d={areaD}
                fill="rgba(138, 134, 128, 0.06)"
              />
            ) : null
          )}

          {/* Neutral score paths (gaps naturally skip missing points) */}
          {runPaths.map((pathD, idx) =>
            pathD ? (
              <path
                key={`line-${idx}`}
                d={pathD}
                fill="none"
                stroke="var(--line-neutral)"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null
          )}

          {/* Alert segments across runs */}
          {alertSegments.map((segment, index) => (
            <path
              key={`alert-${index}`}
              d={segment}
              fill="none"
              stroke="var(--alert)"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* Current point cursor */}
          {currentPoint && (
            <circle
              cx={currentPoint.x}
              cy={currentPoint.y}
              r="4.5"
              fill={isAlert ? 'var(--alert)' : 'var(--line-neutral)'}
              stroke="var(--surface)"
              strokeWidth="2"
            />
          )}
        </svg>
      </div>
    </div>
  );
}
