import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://hdwivjtrzuymjwxggvsf.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhkd2l2anRyenV5bWp3eGdndnNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MjU4NjksImV4cCI6MjEwNDQwMTg2OX0.zB-1iiuM2uRQEqT23sWgKd_neohFXCzNTVDpGT7lEkM';

const sb = createClient(supabaseUrl, supabaseAnonKey);

async function reset() {
  console.log('Clearing threshold_event and resetting transaction_demo in Supabase...');
  const { error: thErr } = await sb.from('threshold_event').delete().neq('id', 0);
  if (thErr) console.error('Error clearing threshold_event:', thErr);

  const { error: txErr } = await sb.from('transaction_demo').update({ state: 'PENDING', locked_at: null }).eq('call_id', 'demo1');
  if (txErr) console.error('Error resetting transaction_demo:', txErr);

  console.log('Reset complete: Approval UI is now back to clean PENDING / UNBLOCKED state.');
}

reset();
