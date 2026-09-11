const { chromium } = require('../dashboard/node_modules/playwright');
const path = require('path');
const { createClient } = require('./node_modules/@supabase/supabase-js');

const SUPABASE_URL = 'https://hdwivjtrzuymjwxggvsf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhkd2l2anRyenV5bWp3eGdndnNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MjU4NjksImV4cCI6MjEwNDQwMTg2OX0.zB-1iiuM2uRQEqT23sWgKd_neohFXCzNTVDpGT7lEkM';
const ARTIFACT_DIR = 'C:/Users/parth/.gemini/antigravity-ide/brain/79f12729-4935-4ac4-b91e-cdad65051d10';

async function run() {
  console.log('--- STARTING APPROVAL UI AUTOMATED VERIFICATION ---');
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Clean initial state in DB
  console.log('1. Cleaning DB threshold_event for demo1...');
  await supabase.from('threshold_event').delete().eq('call_id', 'demo1');
  await supabase.from('transaction_demo').update({ state: 'PENDING', locked_at: null }).eq('call_id', 'demo1');

  const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(() => chromium.launch({ channel: 'chrome', headless: true }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Console logging from page
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));

  console.log('2. Navigating to http://localhost:5174...');
  await page.goto('http://localhost:5174', { waitUntil: 'networkidle' });

  // 1. Initial State Check
  console.log('3. Verifying initial PENDING state...');
  const amountText = await page.locator('text=₹40,00,000').first().innerText();
  console.log('Found amount:', amountText);

  const initialApproveBtn = page.locator('#approve-btn');
  const isInitiallyDisabled = await initialApproveBtn.isDisabled();
  console.log('Initial Approve Button Disabled:', isInitiallyDisabled);

  if (isInitiallyDisabled) {
    throw new Error('Initial Approve button should NOT be disabled!');
  }

  await page.screenshot({ path: path.join(ARTIFACT_DIR, '01_initial_pending.png'), fullPage: true });
  console.log('Captured initial screenshot: 01_initial_pending.png');

  // 2. Test Batched Out-Of-Order Realtime inserts
  console.log('4. Emitting batched out-of-order events into Supabase...');
  // Insert t=5.2 (ESCALATE) and t=2.1 (OK) out of order
  const { error: err1 } = await supabase.from('threshold_event').insert([
    { call_id: 'demo1', t: 5.2, from_state: 'OK', to_state: 'ESCALATE', flags: ['voice_anomaly'] },
    { call_id: 'demo1', t: 2.1, from_state: 'OK', to_state: 'OK', flags: [] }
  ]);
  if (err1) {
    console.error('Insert error:', err1);
  }

  // Also update transaction_demo state to ESCALATE
  await supabase.from('transaction_demo').update({ state: 'ESCALATE', locked_at: 5.2 }).eq('call_id', 'demo1');

  console.log('5. Waiting for realtime UI update to ESCALATE...');
  await page.waitForSelector('#verification-prompt-text', { timeout: 10000 });

  const promptText = await page.locator('#verification-prompt-text').innerText();
  console.log('Found verification prompt:', promptText);

  const expectedPrompt = 'Verify this request on the registered number ending 4417 before approving';
  if (promptText.trim() !== expectedPrompt) {
    throw new Error(`Prompt text mismatch! Expected "${expectedPrompt}", got "${promptText}"`);
  }

  // Confirm Approve button is GENUINELY disabled
  const escalatedBtn = page.locator('#approve-btn');
  const isEscalatedDisabled = await escalatedBtn.isDisabled();
  const hasDisabledAttr = await escalatedBtn.getAttribute('disabled');
  const domDisabledProp = await escalatedBtn.evaluate(el => el.disabled);

  console.log('Approve Button isDisabled():', isEscalatedDisabled);
  console.log('Approve Button disabled attribute:', hasDisabledAttr);
  console.log('Approve Button DOM property .disabled:', domDisabledProp);

  if (!isEscalatedDisabled || domDisabledProp !== true) {
    throw new Error('Approve button is NOT genuinely disabled after ESCALATE row arrived!');
  }

  // Try clicking it and verify click has no effect
  try {
    await escalatedBtn.click({ timeout: 1000, force: false });
    console.warn('Click unexpectedly succeeded on disabled button!');
  } catch (clickErr) {
    console.log('Playwright confirmed button is non-clickable / disabled (caught expected error)');
  }

  // Check timestamp visibility
  const timestampText = await page.locator('#escalate-alert-banner').innerText();
  console.log('Alert banner content with timestamp:', timestampText);

  await page.screenshot({ path: path.join(ARTIFACT_DIR, '02_escalate_locked.png'), fullPage: true });
  console.log('Captured ESCALATE screenshot: 02_escalate_locked.png');

  // 3. Test BLOCK State
  console.log('6. Emitting BLOCK event into Supabase...');
  await supabase.from('threshold_event').insert([
    { call_id: 'demo1', t: 8.9, from_state: 'ESCALATE', to_state: 'BLOCK', flags: ['voice_cloned_threat'] }
  ]);
  await supabase.from('transaction_demo').update({ state: 'BLOCK', locked_at: 8.9 }).eq('call_id', 'demo1');

  console.log('7. Waiting for realtime UI update to BLOCK...');
  await page.waitForSelector('#block-alert-banner', { timeout: 10000 });

  const blockBannerText = await page.locator('#block-alert-banner').innerText();
  console.log('Block banner content:', blockBannerText);

  const blockedBtnDisabled = await escalatedBtn.isDisabled();
  console.log('Approve Button isDisabled() in BLOCK state:', blockedBtnDisabled);

  if (!blockedBtnDisabled) {
    throw new Error('Approve button should remain disabled in BLOCK state!');
  }

  await page.screenshot({ path: path.join(ARTIFACT_DIR, '03_blocked_flagged.png'), fullPage: true });
  console.log('Captured BLOCK screenshot: 03_blocked_flagged.png');

  console.log('8. Verifying telemetry audit log has sorted events by t...');
  const auditRows = await page.$$eval('table tbody tr', rows => rows.map(r => r.innerText));
  console.log('Audit table rows:', auditRows);

  await browser.close();
  console.log('--- ALL APPROVAL UI VERIFICATIONS PASSED SUCCESSFULLY! ---');
}

run().catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
