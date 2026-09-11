import React from 'react';

export default function LayerBars({
  layers = { acoustic: 0, prosody: 0, speaker: 0 },
  isAlert = false
}) {
  const layerConfigs = [
    {
      key: 'acoustic',
      label: 'Acoustic',
      model: 'AASIST (16 kHz waveform)',
      weight: 0.60,
      val: layers.acoustic ?? null
    },
    {
      key: 'prosody',
      label: 'Prosody',
      model: 'F0 contour + rhythm (Praat)',
      weight: 0.15,
      val: layers.prosody ?? null,
      note: 'Jitter/shimmer weight: 0'
    },
    {
      key: 'speaker',
      label: 'Speaker',
      model: 'ECAPA-TDNN vs enrolled ref',
      weight: 0.25,
      val: layers.speaker ?? null
    }
  ];

  return (
    <div style={{
      backgroundColor: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      padding: '20px 24px'
    }}>
      <div style={{
        fontSize: '13px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--text-muted)',
        marginBottom: '16px'
      }}>
        Layer Contributions (Hand-set fusion weights)
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
        {layerConfigs.map((layer) => {
          const isValValid = layer.val !== null && layer.val !== undefined && !isNaN(layer.val);
          const percentage = isValValid ? Math.max(0, Math.min(100, Number(layer.val) * 100)) : 0;
          const layerHigh = isValValid && layer.val >= 0.55;

          return (
            <div key={layer.key} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>
                    {layer.label}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '6px' }}>
                    ({(layer.weight * 100).toFixed(0)}%)
                  </span>
                </div>
                <div style={{
                  fontSize: '16px',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  color: (isAlert && layerHigh) ? 'var(--alert)' : isValValid ? 'var(--text)' : 'var(--text-muted)'
                }}>
                  {isValValid ? Number(layer.val).toFixed(3) : '—'}
                </div>
              </div>

              {/* Progress bar container */}
              <div style={{
                height: '8px',
                width: '100%',
                backgroundColor: 'var(--bg)',
                borderRadius: '4px',
                overflow: 'hidden',
                border: '1px solid var(--border)'
              }}>
                <div style={{
                  height: '100%',
                  width: `${percentage}%`,
                  backgroundColor: (isAlert && layerHigh) ? 'var(--alert)' : 'var(--line-neutral)',
                  transition: 'width 0.3s ease, background-color 0.2s ease'
                }} />
              </div>

              {/* Sub-label */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {layer.model} {layer.note && `· ${layer.note}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
