// Vercel serverless function — Node.js runtime.
// Employee points/rewards ("Tillie's Nest"): the owner awards 5 points by
// clicking a name anywhere one shows in the app; employees spend their own
// balance on an owner-managed reward catalog. Points are keyed by the plain
// employee NAME STRING, not a roster foreign key — most places a name
// renders (Employees/Stores/Retail/Color Sales/DL/60 Day tables) come from
// parsed report data with no guaranteed link to the `employees` login-roster
// row (same "exact-normalized-name, not fuzzy" limitation already true of
// Manager matching elsewhere in this app). Balance updates are a plain
// read-then-upsert, not a stored procedure — this app has no real write
// concurrency to speak of (a single owner clicking a button), matching its
// existing pragmatic style (e.g. the O(n) PIN scan in serverAuth.js).

import { createServiceClient, requireSession } from '../src/serverAuth.js';

const AWARD_AMOUNT = 5;

function serializeTransaction(t) {
  return {
    id: t.id,
    employeeName: t.employee_name,
    delta: t.delta,
    type: t.type,
    rewardId: t.reward_id,
    rewardName: t.reward_name,
    awardedBy: t.awarded_by,
    fulfilled: t.fulfilled,
    createdAt: t.created_at,
  };
}

function serializeReward(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    cost: r.cost,
    stock: r.stock,
    active: r.active,
  };
}

async function getBalance(supabase, name) {
  const { data, error } = await supabase.from('employee_points').select('balance').eq('employee_name', name).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.balance || 0;
}

// Upserts the running balance and returns the new value. Callers are
// responsible for any pre-checks (e.g. redeem verifying sufficient balance
// before calling this) — this function itself just applies the delta.
async function adjustBalance(supabase, name, delta) {
  const current = await getBalance(supabase, name);
  const next = current + delta;
  const { error } = await supabase.from('employee_points').upsert(
    { employee_name: name, balance: next, updated_at: new Date().toISOString() },
    { onConflict: 'employee_name' }
  );
  if (error) throw new Error(error.message);
  return next;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }

  const { action, token, employeeName, id, rewardId, name, description, cost, stock, active, fulfilled } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  const requireOwner = () => {
    if (employee.role !== 'owner') { res.status(403).json({ error: 'Only the owner can do that.' }); return false; }
    return true;
  };

  try {
    if (action === 'balance') {
      const balance = await getBalance(supabase, employee.name);
      const { data: txns, error } = await supabase
        .from('points_transactions').select('*').eq('employee_name', employee.name)
        .order('created_at', { ascending: false }).limit(10);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, balance, transactions: (txns || []).map(serializeTransaction) });
      return;
    }

    if (action === 'award') {
      if (!requireOwner()) return;
      if (!employeeName || !String(employeeName).trim()) { res.status(400).json({ error: 'Missing employee name.' }); return; }
      const cleanName = String(employeeName).trim();
      const balance = await adjustBalance(supabase, cleanName, AWARD_AMOUNT);
      const { error } = await supabase.from('points_transactions').insert({
        employee_name: cleanName, delta: AWARD_AMOUNT, type: 'award', awarded_by: employee.name,
      });
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, balance });
      return;
    }

    if (action === 'allBalances') {
      if (!requireOwner()) return;
      const { data, error } = await supabase.from('employee_points').select('*').order('balance', { ascending: false });
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, balances: (data || []).map(b => ({ employeeName: b.employee_name, balance: b.balance })) });
      return;
    }

    if (action === 'transactions') {
      if (!requireOwner()) return;
      let query = supabase.from('points_transactions').select('*').order('created_at', { ascending: false }).limit(200);
      if (employeeName) query = query.eq('employee_name', employeeName);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, transactions: (data || []).map(serializeTransaction) });
      return;
    }

    if (action === 'deleteTransaction') {
      if (!requireOwner()) return;
      if (!id) { res.status(400).json({ error: 'Missing transaction id.' }); return; }
      const { data: txn, error: fetchError } = await supabase.from('points_transactions').select('*').eq('id', id).maybeSingle();
      if (fetchError) throw new Error(fetchError.message);
      if (!txn) { res.status(404).json({ error: 'Transaction not found.' }); return; }
      await adjustBalance(supabase, txn.employee_name, -txn.delta);
      const { error } = await supabase.from('points_transactions').delete().eq('id', id);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'redeem') {
      if (!rewardId) { res.status(400).json({ error: 'Missing reward.' }); return; }
      const { data: reward, error: rewardError } = await supabase.from('points_rewards').select('*').eq('id', rewardId).maybeSingle();
      if (rewardError) throw new Error(rewardError.message);
      if (!reward || !reward.active) { res.status(400).json({ error: 'That reward is no longer available.' }); return; }
      if (reward.stock != null && reward.stock <= 0) { res.status(400).json({ error: 'That reward is out of stock.' }); return; }
      const balance = await getBalance(supabase, employee.name);
      if (balance < reward.cost) { res.status(400).json({ error: "You don't have enough points for that yet." }); return; }
      if (reward.stock != null) {
        const { error: stockError } = await supabase.from('points_rewards').update({ stock: reward.stock - 1 }).eq('id', reward.id);
        if (stockError) throw new Error(stockError.message);
      }
      const newBalance = await adjustBalance(supabase, employee.name, -reward.cost);
      const { error } = await supabase.from('points_transactions').insert({
        employee_name: employee.name, delta: -reward.cost, type: 'redeem', reward_id: reward.id, reward_name: reward.name,
      });
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, balance: newBalance });
      return;
    }

    if (action === 'listRewards') {
      let query = supabase.from('points_rewards').select('*').order('cost');
      if (employee.role !== 'owner') query = query.eq('active', true);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, rewards: (data || []).map(serializeReward) });
      return;
    }

    if (action === 'saveReward') {
      if (!requireOwner()) return;
      if (!name || !String(name).trim()) { res.status(400).json({ error: 'Reward needs a name.' }); return; }
      const costNum = Number(cost);
      if (!Number.isFinite(costNum) || costNum <= 0) { res.status(400).json({ error: 'Cost must be a positive number.' }); return; }
      const stockNum = stock === '' || stock == null ? null : Number(stock);
      if (stockNum != null && (!Number.isFinite(stockNum) || stockNum < 0)) { res.status(400).json({ error: 'Stock must be blank (unlimited) or a non-negative number.' }); return; }
      const row = {
        name: String(name).trim(), description: description ? String(description).trim() : null,
        cost: costNum, stock: stockNum, active: active !== false,
      };
      if (id) {
        const { error } = await supabase.from('points_rewards').update(row).eq('id', id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from('points_rewards').insert(row);
        if (error) throw new Error(error.message);
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'deleteReward') {
      if (!requireOwner()) return;
      if (!id) { res.status(400).json({ error: 'Missing reward id.' }); return; }
      const { error } = await supabase.from('points_rewards').delete().eq('id', id);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'markFulfilled') {
      if (!requireOwner()) return;
      if (!id) { res.status(400).json({ error: 'Missing transaction id.' }); return; }
      const { error } = await supabase.from('points_transactions').update({ fulfilled: !!fulfilled }).eq('id', id);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
