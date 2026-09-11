import React, { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from './supabaseClient';

// Styling adhering strictly to Reference/Design-System.md:
// Light theme only. No dark mode. No toggle.
// Only --alert: #C2410C for threshold crossings / blocked states.
// NEVER color the safe state green!

export default function App() {
  const [transaction, setTransaction] = useState({
    txn_id: 'TXN-2026-904417',
    call_id: 'demo1',
    amount: 4000000,
    debtor_account: 'Enterprise Treasury A/C •••• 4417',
    beneficiary_name: 'Singhania Industrial Equipment Corp.',
    beneficiary_account: '00921040008829',
    beneficiary_bank: 'HDFC Bank Ltd — Nariman Point, Mumbai',
    ifsc: 'HDFC0000240',
    type: 'RTGS Priority Wire',
    initiated_by: 'R. Sharma (Treasury Desk 04)',
    state: 'PENDING',
    updated_at: null,
    locked_at_t: null
  });

  // Event buffer for threshold and transaction events, sorted by t
  const [events, setEvents] = useState([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [isApproved, setIsApproved] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('connecting');

  // Add event helper ensuring chronological sort by t
  const addEventsAndResolveState = (newRows) => {
    if (!Array.isArray(newRows)) {
      newRows = [newRows];
    }
    setEvents((prev) => {
      // Merge unique events by id or timestamp key
      const merged = [...prev];
      for (const row of newRows) {
        const key = row.id || `${row.call_id}_${row.t}_${row.to_state || row.state}`;
        if (!merged.some((e) => (e.id && e.id === row.id) || e._key === key)) {
          merged.push({ ...row, _key: key, received_at: new Date().toISOString() });
        }
      }
      // CRITICAL: Sort incoming realtime rows by t before rendering — batched inserts can arrive out of order
      merged.sort((a, b) => {
        const tA = typeof a.t === 'number' ? a.t : (typeof a.locked_at === 'number' ? a.locked_at : 0);
        const tB = typeof b.t === 'number' ? b.t : (typeof b.locked_at === 'number' ? b.locked_at : 0);
        return tA - tB;
      });
      return merged;
    });
  };

  // Derive current state and latest timestamp from the sorted events
  const { currentState, stateTimestamp, latestT } = useMemo(() => {
    let state = transaction.state || 'PENDING';
    let timestamp = transaction.updated_at;
    let tVal = transaction.locked_at_t;

    if (events.length > 0) {
      // Last event in sorted array has highest t
      const latest = events[events.length - 1];
      const targetState = latest.to_state || latest.state;
      if (targetState) {
        state = targetState;
        timestamp = latest.received_at || new Date().toISOString();
        tVal = latest.t ?? latest.locked_at ?? null;
      }
    }

    return {
      currentState: state,
      stateTimestamp: timestamp,
      latestT: tVal
    };
  }, [events, transaction]);

  // Initial load and Realtime subscriptions
  useEffect(() => {
    if (!supabase) {
      setConnectionStatus('supabase-not-configured');
      return;
    }

    // 1. Fetch initial state if rows exist
    const fetchInitialData = async () => {
      try {
        const { data: thresholdData, error: threshErr } = await supabase
          .from('threshold_event')
          .select('*')
          .order('t', { ascending: true });

        if (!threshErr && thresholdData && thresholdData.length > 0) {
          addEventsAndResolveState(thresholdData);
        }

        const { data: txnData, error: txnErr } = await supabase
          .from('transaction_demo')
          .select('*')
          .limit(1);

        if (!txnErr && txnData && txnData.length > 0) {
          const row = txnData[0];
          setTransaction((prev) => ({
            ...prev,
            txn_id: row.txn_id || prev.txn_id,
            call_id: row.call_id || prev.call_id,
            amount: row.amount || prev.amount,
            state: row.state || prev.state,
            locked_at_t: row.locked_at
          }));
          if (row.state && row.state !== 'OK' && row.state !== 'PENDING') {
            addEventsAndResolveState({
              t: row.locked_at || 0,
              to_state: row.state,
              source: 'transaction_demo',
              received_at: new Date().toISOString()
            });
          }
        }
      } catch (err) {
        console.error('Initial fetch error:', err);
      }
    };

    fetchInitialData();

    // 2. Subscribe to Supabase realtime on transaction_demo and threshold_event
    const channel = supabase
      .channel('approval-realtime-sub')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transaction_demo' },
        (payload) => {
          const row = payload.new;
          if (row) {
            setTransaction((prev) => ({
              ...prev,
              txn_id: row.txn_id || prev.txn_id,
              amount: row.amount || prev.amount,
              state: row.state || prev.state,
              locked_at_t: row.locked_at,
              updated_at: new Date().toISOString()
            }));
            if (row.state) {
              addEventsAndResolveState({
                t: row.locked_at ?? 0,
                to_state: row.state,
                source: 'transaction_demo_realtime'
              });
            }
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'threshold_event' },
        (payload) => {
          if (payload.new) {
            addEventsAndResolveState(payload.new);
          }
        }
      )
      .subscribe((status) => {
        setConnectionStatus(status === 'SUBSCRIBED' ? 'connected' : status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const isEscalated = currentState === 'ESCALATE';
  const isBlocked = currentState === 'BLOCK';
  // Button must be genuinely disabled on ESCALATE or BLOCK
  const isApproveDisabled = isEscalated || isBlocked || isApproved;

  const handleApprove = () => {
    if (isApproveDisabled) return;
    setIsApproved(true);
    setStatusMessage('Wire transfer authorization signed and released to RTGS gateway.');
  };

  // Helper for direct test simulation (useful for demos and quick verification)
  const triggerSimulation = async (stateToTrigger, t = 4.5) => {
    try {
      if (supabase) {
        await supabase.from('threshold_event').insert({
          call_id: transaction.call_id || 'demo1',
          t: t,
          from_state: currentState,
          to_state: stateToTrigger,
          flags: stateToTrigger === 'ESCALATE' ? ['voice_anomaly'] : ['voice_cloned_threat']
        });
      } else {
        // Fallback local test event
        addEventsAndResolveState({
          t,
          from_state: currentState,
          to_state: stateToTrigger,
          flags: stateToTrigger === 'ESCALATE' ? ['voice_anomaly'] : ['voice_cloned_threat']
        });
      }
    } catch (e) {
      console.error('Simulation trigger error:', e);
      addEventsAndResolveState({
        t,
        from_state: currentState,
        to_state: stateToTrigger,
        flags: ['local_simulation']
      });
    }
  };

  // Helper to reset transaction state both in database and local UI
  const handleReset = async () => {
    try {
      if (supabase) {
        await supabase.from('threshold_event').delete().neq('id', 0);
        await supabase.from('transaction_demo').update({ state: 'PENDING', locked_at: null }).eq('call_id', transaction.call_id || 'demo1');
      }
    } catch (e) {
      console.error('Reset database error:', e);
    }
    setEvents([]);
    setIsApproved(false);
    setStatusMessage('');
    setTransaction((prev) => ({
      ...prev,
      state: 'PENDING',
      locked_at_t: null,
      updated_at: null
    }));
  };

  return (
    <div style={styles.container}>
      {/* Top Header Bar */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.bankLogoBadge}>APEX BANK</div>
          <div>
            <h1 style={styles.headerTitle}>TREASURY WIRE AUTHORIZATION</h1>
            <div style={styles.headerSubtitle}>
              Core Banking Settlement &bull; Ref #{transaction.txn_id} &bull; Call Link #{transaction.call_id}
            </div>
          </div>
        </div>
        <div style={styles.headerRight}>
          <div style={styles.statusIndicator}>
            <span
              style={{
                ...styles.statusDot,
                backgroundColor: connectionStatus === 'connected' ? 'var(--line-neutral)' : 'var(--alert)'
              }}
            />
            <span style={styles.statusText}>
              Supabase Realtime: {connectionStatus}
            </span>
          </div>
          {/* Quick test buttons for demo verification */}
          <div style={styles.testToolbar}>
            <span style={styles.testToolbarLabel}>Simulation Controls:</span>
            <button
              style={styles.testBtn}
              onClick={() => triggerSimulation('ESCALATE', 5.2)}
              title="Emit ESCALATE threshold event"
            >
              Emit ESCALATE (t=5.2s)
            </button>
            <button
              style={styles.testBtn}
              onClick={() => triggerSimulation('BLOCK', 8.9)}
              title="Emit BLOCK threshold event"
            >
              Emit BLOCK (t=8.9s)
            </button>
            <button
              style={{ ...styles.testBtn, color: 'var(--text-muted)' }}
              onClick={handleReset}
              title="Reset state to pending and clear alerts"
            >
              Reset to PENDING
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={styles.main}>
        {/* Banner area for State Alerts */}
        {isEscalated && (
          <div style={styles.escalateBanner} id="escalate-alert-banner">
            <div style={styles.alertHeaderRow}>
              <div style={styles.alertTag}>AUTHORIZATION LOCKED &bull; ESCALATE</div>
              {stateTimestamp && (
                <div style={styles.stateTimestampBadge}>
                  State change recorded: {new Date(stateTimestamp).toLocaleTimeString()} {latestT != null ? `(t = ${latestT}s)` : ''}
                </div>
              )}
            </div>
            <div style={styles.escalatePromptText} id="escalate-prompt">
              Verify this request on the registered number ending 4417 before approving
            </div>
            <div style={styles.escalateSubtext}>
              Live call audio flagged anomaly threshold (0.55&ndash;0.80). Approval action is disabled pending out-of-band verification.
            </div>
          </div>
        )}

        {isBlocked && (
          <div style={styles.blockBanner} id="block-alert-banner">
            <div style={styles.alertHeaderRow}>
              <div style={styles.alertTag}>TRANSACTION HELD &amp; FLAGGED &bull; BLOCK</div>
              {stateTimestamp && (
                <div style={styles.stateTimestampBadge}>
                  State change recorded: {new Date(stateTimestamp).toLocaleTimeString()} {latestT != null ? `(t = ${latestT}s)` : ''}
                </div>
              )}
            </div>
            <div style={styles.blockTitleText}>
              Transaction Held &bull; Critical Voice-Cloning Anomaly Threshold Exceeded (&gt;0.80)
            </div>
            <div style={styles.blockSubtext}>
              This transfer has been frozen by automated voice security policy. High synthetic-voice confidence detected on caller line. Wire transfer processing has been suspended and flagged for investigation.
            </div>
          </div>
        )}

        {/* Transaction Detail Card */}
        <section style={styles.card}>
          <div style={styles.cardHeader}>
            <div>
              <div style={styles.metaLabel}>TRANSFER AMOUNT (INR)</div>
              {/* Primary Amount readout styled clearly */}
              <div style={styles.amountDisplay}>
                ₹40,00,000<span style={styles.amountDecimals}>.00</span>
              </div>
              <div style={styles.amountWords}>INR Forty Lakhs Only</div>
            </div>

            <div style={styles.stateContainer}>
              <div style={styles.metaLabel}>AUTHORIZATION STATUS</div>
              <div
                id="transaction-state-badge"
                style={{
                  ...styles.stateBadge,
                  borderColor: isBlocked || isEscalated ? 'var(--alert)' : 'var(--border)',
                  color: isBlocked || isEscalated ? 'var(--alert)' : 'var(--text)'
                }}
              >
                {isBlocked ? 'HELD & FLAGGED (BLOCK)' : isEscalated ? 'LOCKED (ESCALATE)' : isApproved ? 'APPROVED' : 'PENDING APPROVAL'}
              </div>
              {stateTimestamp && (
                <div style={styles.timestampUnderBadge}>
                  Updated: {new Date(stateTimestamp).toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>

          <div style={styles.divider} />

          {/* Transfer Particulars Grid */}
          <div style={styles.grid}>
            <div style={styles.gridItem}>
              <span style={styles.fieldLabel}>Debtor / Source Account</span>
              <span style={styles.fieldValueBold}>{transaction.debtor_account}</span>
              <span style={styles.fieldSub}>Primary Liquidity Pool &bull; Corporate Banking</span>
            </div>

            <div style={styles.gridItem}>
              <span style={styles.fieldLabel}>Beneficiary Name</span>
              <span style={styles.fieldValueBold}>{transaction.beneficiary_name}</span>
              <span style={styles.fieldSub}>Vendor ID: VEND-89021</span>
            </div>

            <div style={styles.gridItem}>
              <span style={styles.fieldLabel}>Beneficiary Account</span>
              <span style={styles.fieldValueMono}>{transaction.beneficiary_account}</span>
              <span style={styles.fieldSub}>{transaction.beneficiary_bank}</span>
            </div>

            <div style={styles.gridItem}>
              <span style={styles.fieldLabel}>IFSC &amp; Settlement Route</span>
              <span style={styles.fieldValueMono}>{transaction.ifsc} &bull; {transaction.type}</span>
              <span style={styles.fieldSub}>Immediate Gross Settlement</span>
            </div>

            <div style={styles.gridItem}>
              <span style={styles.fieldLabel}>Maker / Initiated By</span>
              <span style={styles.fieldValue}>{transaction.initiated_by}</span>
              <span style={styles.fieldSub}>Desk Terminal: DL-MUM-402</span>
            </div>

            <div style={styles.gridItem}>
              <span style={styles.fieldLabel}>Voice Call Session Monitor</span>
              <span style={styles.fieldValueMono}>
                Call ID: {transaction.call_id}
              </span>
              <span style={styles.fieldSub}>
                Synthetic-Voice Layer: AASIST + ECAPA + Prosody
              </span>
            </div>
          </div>

          <div style={styles.divider} />

          {/* Action Footer Section */}
          <div style={styles.actionSection}>
            {isEscalated ? (
              /* ESCALATE State: Approve button is genuinely disabled and replaced by the verification prompt */
              <div style={styles.escalatedActionBox} id="escalate-action-container">
                <div style={styles.promptCallout}>
                  <div style={styles.promptIcon}>⚠️</div>
                  <div style={styles.promptContent}>
                    <div style={styles.promptRequiredTitle}>Out-of-Band Callback Verification Required</div>
                    <div style={styles.promptExactText} id="verification-prompt-text">
                      Verify this request on the registered number ending 4417 before approving
                    </div>
                  </div>
                </div>

                <div style={styles.actionButtonRow}>
                  {/* Button is genuinely disabled with HTML attribute disabled */}
                  <button
                    id="approve-btn"
                    disabled={true}
                    aria-disabled="true"
                    style={{
                      ...styles.approveBtn,
                      ...styles.approveBtnDisabled
                    }}
                    title="Approval disabled due to ESCALATE state"
                  >
                    🔒 Approve Wire Transfer (Locked)
                  </button>
                  <button style={styles.secondaryBtn} disabled={true}>
                    Reject Request
                  </button>
                </div>
              </div>
            ) : isBlocked ? (
              /* BLOCK State: Transaction held & flagged, approve button strictly disabled */
              <div style={styles.blockedActionBox} id="block-action-container">
                <div style={styles.blockedNotice}>
                  <div style={styles.blockedNoticeText}>
                    <strong>Transaction Frozen:</strong> Security hold in effect. No authorization can be performed while state is BLOCK.
                  </div>
                </div>
                <div style={styles.actionButtonRow}>
                  <button
                    id="approve-btn"
                    disabled={true}
                    aria-disabled="true"
                    style={{
                      ...styles.approveBtn,
                      ...styles.approveBtnDisabled
                    }}
                  >
                    🚫 Approve Wire Transfer (Frozen)
                  </button>
                  <button
                    style={styles.flagBtn}
                    onClick={() => setStatusMessage('Incident incident report escalated to Fraud Risk Team.')}
                  >
                    Flag to Incident Desk
                  </button>
                </div>
              </div>
            ) : (
              /* Normal / Pending State: Approve button active */
              <div style={styles.normalActionBox} id="pending-action-container">
                <div style={styles.actionButtonRow}>
                  <button
                    id="approve-btn"
                    disabled={isApproveDisabled}
                    onClick={handleApprove}
                    style={{
                      ...styles.approveBtn,
                      ...(isApproveDisabled ? styles.approveBtnDisabled : {})
                    }}
                  >
                    {isApproved ? '✓ Wire Transfer Approved' : 'Approve Wire Transfer (₹40,00,000)'}
                  </button>
                  <button
                    style={styles.secondaryBtn}
                    disabled={isApproved}
                    onClick={() => setStatusMessage('Transfer held for secondary manual review.')}
                  >
                    Hold for Review
                  </button>
                </div>
                {statusMessage && (
                  <div style={styles.statusNotification}>{statusMessage}</div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Realtime Event Stream & Audit Log (Sorted strictly by t) */}
        <section style={styles.auditCard}>
          <div style={styles.auditHeader}>
            <span style={styles.auditTitle}>REALTIME TELEMETRY AUDIT TRAIL</span>
            <span style={styles.auditSubtitle}>
              Events received via Supabase Realtime &bull; Sorted chronologically by t
            </span>
          </div>

          {events.length === 0 ? (
            <div style={styles.emptyLog}>
              Awaiting realtime events from voice inference pipeline (<code>threshold_event</code> / <code>transaction_demo</code>)...
            </div>
          ) : (
            <table style={styles.auditTable}>
              <thead>
                <tr style={styles.auditTr}>
                  <th style={styles.auditTh}>t (sec)</th>
                  <th style={styles.auditTh}>Call ID</th>
                  <th style={styles.auditTh}>Transition</th>
                  <th style={styles.auditTh}>Target State</th>
                  <th style={styles.auditTh}>Flags / Reason</th>
                  <th style={styles.auditTh}>Arrival Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev, idx) => {
                  const isLatest = idx === events.length - 1;
                  return (
                    <tr
                      key={ev._key || idx}
                      style={{
                        ...styles.auditTr,
                        backgroundColor: isLatest ? 'var(--bg)' : 'transparent',
                        fontWeight: isLatest ? '600' : 'normal'
                      }}
                    >
                      <td style={styles.auditTdMono}>
                        {typeof ev.t === 'number' ? `${ev.t.toFixed(2)}s` : (ev.locked_at ? `${ev.locked_at}s` : '0.00s')}
                      </td>
                      <td style={styles.auditTdMono}>{ev.call_id || transaction.call_id}</td>
                      <td style={styles.auditTd}>
                        {ev.from_state ? `${ev.from_state} → ${ev.to_state}` : (ev.to_state || ev.state)}
                      </td>
                      <td style={styles.auditTd}>
                        <span
                          style={{
                            ...styles.pill,
                            color: (ev.to_state || ev.state) === 'BLOCK' || (ev.to_state || ev.state) === 'ESCALATE'
                              ? 'var(--alert)'
                              : 'var(--text)'
                          }}
                        >
                          {ev.to_state || ev.state}
                        </span>
                      </td>
                      <td style={styles.auditTd}>
                        {ev.flags ? JSON.stringify(ev.flags) : (ev.source || 'threshold_event')}
                      </td>
                      <td style={styles.auditTdMono}>
                        {ev.received_at ? new Date(ev.received_at).toLocaleTimeString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    display: 'flex',
    flexDirection: 'column'
  },
  header: {
    backgroundColor: 'var(--surface)',
    borderBottom: '1px solid var(--border)',
    padding: '16px 32px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '16px'
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px'
  },
  bankLogoBadge: {
    backgroundColor: 'var(--text)',
    color: 'var(--surface)',
    padding: '6px 12px',
    fontSize: '13px',
    fontWeight: '700',
    letterSpacing: '1px',
    borderRadius: '2px'
  },
  headerTitle: {
    fontSize: '18px',
    fontWeight: '600',
    letterSpacing: '0.5px'
  },
  headerSubtitle: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    marginTop: '2px'
  },
  headerRight: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '8px'
  },
  statusIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '12px',
    color: 'var(--text-muted)'
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%'
  },
  statusText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px'
  },
  testToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px'
  },
  testToolbarLabel: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    marginRight: '2px'
  },
  testBtn: {
    padding: '4px 8px',
    fontSize: '11px',
    border: '1px solid var(--border)',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    cursor: 'pointer',
    borderRadius: '2px'
  },
  main: {
    flex: 1,
    maxWidth: '1040px',
    margin: '0 auto',
    width: '100%',
    padding: '32px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px'
  },
  // Banners
  escalateBanner: {
    backgroundColor: 'var(--alert-bg)',
    borderTop: '1px solid var(--alert-border)',
    borderRight: '1px solid var(--alert-border)',
    borderBottom: '1px solid var(--alert-border)',
    borderLeft: '4px solid var(--alert)',
    padding: '20px 24px',
    borderRadius: '2px'
  },
  blockBanner: {
    backgroundColor: 'var(--alert-bg)',
    borderTop: '1px solid var(--alert-border)',
    borderRight: '1px solid var(--alert-border)',
    borderBottom: '1px solid var(--alert-border)',
    borderLeft: '4px solid var(--alert)',
    padding: '20px 24px',
    borderRadius: '2px'
  },
  alertHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
    flexWrap: 'wrap',
    gap: '8px'
  },
  alertTag: {
    fontSize: '12px',
    fontWeight: '700',
    letterSpacing: '1px',
    color: 'var(--alert)'
  },
  stateTimestampBadge: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--alert)'
  },
  escalatePromptText: {
    fontSize: '18px',
    fontWeight: '600',
    color: 'var(--text)',
    marginTop: '4px',
    marginBottom: '6px'
  },
  escalateSubtext: {
    fontSize: '13px',
    color: 'var(--text-muted)'
  },
  blockTitleText: {
    fontSize: '18px',
    fontWeight: '600',
    color: 'var(--alert)',
    marginBottom: '6px'
  },
  blockSubtext: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    lineHeight: '1.5'
  },
  // Main Card
  card: {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '2px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
  },
  cardHeader: {
    padding: '28px 32px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: '20px'
  },
  metaLabel: {
    fontSize: '12px',
    fontWeight: '600',
    letterSpacing: '0.8px',
    color: 'var(--text-muted)',
    marginBottom: '6px'
  },
  amountDisplay: {
    fontSize: '44px',
    fontWeight: '700',
    color: 'var(--text)',
    letterSpacing: '-0.5px',
    lineHeight: '1'
  },
  amountDecimals: {
    fontSize: '24px',
    fontWeight: '400',
    color: 'var(--text-muted)'
  },
  amountWords: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    marginTop: '6px'
  },
  stateContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end'
  },
  stateBadge: {
    border: '1px solid var(--border)',
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: '600',
    letterSpacing: '0.5px',
    backgroundColor: 'var(--bg)',
    borderRadius: '2px'
  },
  timestampUnderBadge: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-muted)',
    marginTop: '6px'
  },
  divider: {
    height: '1px',
    backgroundColor: 'var(--border)',
    width: '100%'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '24px',
    padding: '28px 32px'
  },
  gridItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px'
  },
  fieldLabel: {
    fontSize: '12px',
    color: 'var(--text-muted)'
  },
  fieldValue: {
    fontSize: '14px',
    color: 'var(--text)'
  },
  fieldValueBold: {
    fontSize: '14px',
    fontWeight: '600',
    color: 'var(--text)'
  },
  fieldValueMono: {
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text)'
  },
  fieldSub: {
    fontSize: '12px',
    color: 'var(--text-muted)'
  },
  // Actions
  actionSection: {
    padding: '24px 32px',
    backgroundColor: 'var(--bg)',
    borderTop: '1px solid var(--border)'
  },
  normalActionBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px'
  },
  actionButtonRow: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center'
  },
  approveBtn: {
    backgroundColor: 'var(--text)',
    color: 'var(--surface)',
    border: 'none',
    padding: '14px 28px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    borderRadius: '2px',
    transition: 'opacity 0.15s ease'
  },
  approveBtnDisabled: {
    backgroundColor: 'var(--border)',
    color: 'var(--text-muted)',
    cursor: 'not-allowed',
    opacity: 0.65,
    pointerEvents: 'none'
  },
  secondaryBtn: {
    backgroundColor: 'transparent',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    padding: '14px 24px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    borderRadius: '2px'
  },
  flagBtn: {
    backgroundColor: 'transparent',
    color: 'var(--alert)',
    border: '1px solid var(--alert)',
    padding: '14px 24px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    borderRadius: '2px'
  },
  statusNotification: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    fontStyle: 'italic'
  },
  escalatedActionBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  },
  promptCallout: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-start',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    borderLeft: '4px solid var(--alert)',
    padding: '16px'
  },
  promptIcon: {
    fontSize: '20px',
    lineHeight: '1'
  },
  promptContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px'
  },
  promptRequiredTitle: {
    fontSize: '12px',
    fontWeight: '700',
    letterSpacing: '0.5px',
    color: 'var(--alert)',
    textTransform: 'uppercase'
  },
  promptExactText: {
    fontSize: '15px',
    fontWeight: '600',
    color: 'var(--text)'
  },
  blockedActionBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  },
  blockedNotice: {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    padding: '14px 18px',
    fontSize: '13px',
    color: 'var(--text)'
  },
  blockedNoticeText: {
    fontSize: '13px',
    color: 'var(--text)'
  },
  // Audit Table
  auditCard: {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '2px',
    padding: '24px'
  },
  auditHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
    flexWrap: 'wrap',
    gap: '8px'
  },
  auditTitle: {
    fontSize: '13px',
    fontWeight: '600',
    letterSpacing: '0.8px',
    color: 'var(--text)'
  },
  auditSubtitle: {
    fontSize: '12px',
    color: 'var(--text-muted)'
  },
  emptyLog: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    padding: '24px 0',
    textAlign: 'center',
    fontStyle: 'italic'
  },
  auditTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px'
  },
  auditTr: {
    borderBottom: '1px solid var(--border)'
  },
  auditTh: {
    textAlign: 'left',
    padding: '10px 12px',
    fontSize: '12px',
    fontWeight: '600',
    color: 'var(--text-muted)',
    letterSpacing: '0.5px'
  },
  auditTd: {
    padding: '10px 12px',
    color: 'var(--text)'
  },
  auditTdMono: {
    padding: '10px 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--text)'
  },
  pill: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    fontWeight: '600'
  }
};
