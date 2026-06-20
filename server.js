const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// Load .env only on local machine
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// ===== DEBUG ENV =====
console.log('ENV CHECK:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ Found' : '❌ Missing');
console.log('SUPABASE_KEY:', process.env.SUPABASE_ANON_KEY ? '✅ Found' : '❌ Missing');
console.log('GROQ_KEY:', process.env.GROQ_API_KEY ? '✅ Found' : '❌ Missing');

const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== SUPABASE =====
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);
console.log('✅ Supabase client created');

// ===== RAZORPAY =====
let razorpay = null;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('💳 Razorpay: ✅ Connected');
  } else {
    console.log('💳 Razorpay: ⏳ Keys not added yet');
  }
} catch(e) {
  console.log('💳 Razorpay error:', e.message);
}

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===== HTML PAGES =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/payment.html', (req, res) => res.sendFile(path.join(__dirname, 'payment.html')));

// ===== HELPER =====
async function getUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) throw new Error('No token');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) throw new Error('Invalid token');
  return user;
}

// ===== TEST =====
app.get('/api/test', (req, res) => {
  res.json({
    status: 'success',
    message: '🧠 LifeCoach AI Server Running!',
    groq: !!process.env.GROQ_API_KEY,
    supabase: !!process.env.SUPABASE_URL,
    razorpay: !!razorpay
  });
});

// ===== SIGNUP =====
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    const full_name = `${firstName} ${lastName}`;
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name } }
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, user: data.user, session: data.session });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== LOGIN =====
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    if (!data.session) return res.status(400).json({ error: 'No session returned' });
    res.json({ success: true, user: data.user, session: data.session });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== LOGOUT =====
app.post('/api/auth/logout', async (req, res) => {
  try {
    await supabase.auth.signOut();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PROFILE =====
app.get('/api/profile', async (req, res) => {
  try {
    const user = await getUser(req);
    const { data: profile } = await supabase
      .from('profiles').select('*').eq('id', user.id).single();
    res.json({ success: true, user, profile });
  } catch(e) { res.status(401).json({ error: e.message }); }
});

// ===== TRIAL STATUS =====
app.get('/api/trial-status', async (req, res) => {
  try {
    const user = await getUser(req);
    const { data: profile } = await supabase
      .from('profiles').select('*').eq('id', user.id).single();
    if (!profile) return res.json({ plan: 'trial', trialActive: true, daysLeft: 7 });
    const plan = profile.plan || 'trial';
    if (plan === 'pro') return res.json({ plan: 'pro', trialActive: true, daysLeft: 999 });
    const trialEnd = new Date(profile.trial_ends_at);
    const now = new Date();
    const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
    res.json({ plan, trialActive: daysLeft > 0, daysLeft: Math.max(0, daysLeft) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== CHAT LIMIT =====
app.get('/api/chat-limit', async (req, res) => {
  try {
    const user = await getUser(req);
    const { data: profile } = await supabase
      .from('profiles').select('plan, trial_ends_at').eq('id', user.id).single();
    const plan = profile?.plan || 'trial';
    if (plan === 'pro') {
      return res.json({ allowed: true, plan: 'pro', chatsUsed: 0, chatsLimit: 999, unlimited: true });
    }
    if (plan === 'trial' && profile?.trial_ends_at) {
      const trialEnd = new Date(profile.trial_ends_at);
      if (trialEnd < new Date()) {
        return res.json({ allowed: false, plan: 'expired', reason: 'trial_expired', message: 'Your free trial has ended. Upgrade to Pro!' });
      }
    }
    const today = new Date().toISOString().split('T')[0];
    const { data: usage } = await supabase
      .from('chat_usage').select('count').eq('user_id', user.id).eq('date', today).single();
    const chatsUsed = usage?.count || 0;
    const chatsLimit = 20;
    const allowed = chatsUsed < chatsLimit;
    res.json({ allowed, plan, chatsUsed, chatsLimit, chatsLeft: Math.max(0, chatsLimit - chatsUsed), unlimited: false, message: allowed ? null : 'Daily limit reached! Upgrade to Pro for unlimited chats.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== CHAT INCREMENT =====
app.post('/api/chat-increment', async (req, res) => {
  try {
    const user = await getUser(req);
    const today = new Date().toISOString().split('T')[0];
    const { data: existing } = await supabase
      .from('chat_usage').select('id, count').eq('user_id', user.id).eq('date', today).single();
    if (existing) {
      await supabase.from('chat_usage').update({ count: existing.count + 1 }).eq('id', existing.id);
    } else {
      await supabase.from('chat_usage').insert([{ user_id: user.id, date: today, count: 1 }]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== HABITS =====
app.get('/api/habits', async (req, res) => {
  try {
    const user = await getUser(req);
    const { data, error } = await supabase.from('habits').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: true });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, habits: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/habits', async (req, res) => {
  try {
    const user = await getUser(req);
    const { name, frequency } = req.body;
    const { data, error } = await supabase.from('habits')
      .insert([{ user_id: user.id, name, frequency }]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, habit: data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/habits/:id', async (req, res) => {
  try {
    const user = await getUser(req);
    const { completed_today, streak } = req.body;
    const { data, error } = await supabase.from('habits')
      .update({ completed_today, streak })
      .eq('id', req.params.id).eq('user_id', user.id).select();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, habit: data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/habits/:id', async (req, res) => {
  try {
    const user = await getUser(req);
    const { error } = await supabase.from('habits')
      .delete().eq('id', req.params.id).eq('user_id', user.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== GOALS =====
app.get('/api/goals', async (req, res) => {
  try {
    const user = await getUser(req);
    const { data, error } = await supabase.from('goals').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: true });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, goals: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/goals', async (req, res) => {
  try {
    const user = await getUser(req);
    const { title, total_weeks } = req.body;
    const { data, error } = await supabase.from('goals')
      .insert([{ user_id: user.id, title, total_weeks, weeks_left: total_weeks }]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, goal: data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/goals/:id', async (req, res) => {
  try {
    const user = await getUser(req);
    const { progress } = req.body;
    const { data, error } = await supabase.from('goals')
      .update({ progress }).eq('id', req.params.id).eq('user_id', user.id).select();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, goal: data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== CHECKIN =====
app.post('/api/checkin', async (req, res) => {
  try {
    const user = await getUser(req);
    const { mood, thoughts, focus } = req.body;
    let ai_response = 'Thank you for checking in! Keep going! 💪';
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: `You are a warm AI life coach. User mood: ${mood}/7. They said: "${thoughts}". Focus: "${focus}". Give personalized encouragement in 3 sentences with one tip.` }], max_tokens: 200 })
      });
      const groqData = await groqRes.json();
      ai_response = groqData.choices?.[0]?.message?.content || ai_response;
    } catch(e) { console.error('Groq error:', e.message); }
    const { data, error } = await supabase.from('checkins')
      .insert([{ user_id: user.id, mood, thoughts, focus, ai_response }]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, checkin: data[0], ai_response });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/checkins', async (req, res) => {
  try {
    const user = await getUser(req);
    const { data, error } = await supabase.from('checkins').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(7);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, checkins: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== JOURNAL =====
app.post('/api/journal', async (req, res) => {
  try {
    const user = await getUser(req);
    const { content } = req.body;
    let ai_response = 'Thank you for sharing. Keep reflecting! 🌱';
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: `You are a compassionate AI life coach. Journal entry: "${content}". Respond with empathy and one gentle question in 3 sentences.` }], max_tokens: 200 })
      });
      const groqData = await groqRes.json();
      ai_response = groqData.choices?.[0]?.message?.content || ai_response;
    } catch(e) { console.error('Groq error:', e.message); }
    const { data, error } = await supabase.from('journal_entries')
      .insert([{ user_id: user.id, content, ai_response }]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, entry: data[0], ai_response });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/journal', async (req, res) => {
  try {
    const user = await getUser(req);
    const { data, error } = await supabase.from('journal_entries').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, entries: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== AI CHAT =====
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Groq key missing' });
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages, max_tokens: 300, temperature: 0.8 })
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: err });
    }
    const data = await response.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PAYMENT CREATE ORDER =====
app.post('/api/payment/create-order', async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Payment system not configured yet. Coming soon!' });
    const user = await getUser(req);
    const { plan } = req.body;
    const amount = plan === 'yearly' ? 249900 : 29900;
    const order = await razorpay.orders.create({
      amount, currency: 'INR',
      receipt: `order_${user.id}_${Date.now()}`,
      notes: { user_id: user.id, plan }
    });
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== PAYMENT VERIFY =====
app.post('/api/payment/verify', async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Payment system not configured yet.' });
    const user = await getUser(req);
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString()).digest('hex');
    if (expectedSignature !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });
    const { error } = await supabase.from('profiles')
      .update({ plan: 'pro', razorpay_payment_id }).eq('id', user.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, message: '🎉 Pro plan activated!', plan: 'pro' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log('');
  console.log('🧠 LifeCoach AI Server Started!');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔑 Groq: ${process.env.GROQ_API_KEY ? '✅' : '❌'}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌'}`);
  console.log('');
});

module.exports = app;