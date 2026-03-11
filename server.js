/**
 * Stock Club Backend
 * ==================
 * - Serves checkout sessions via Stripe
 * - Listens for Stripe webhooks (payment confirmed)
 * - On successful payment → sends Telegram invite link to member
 *
 * Stack: Node.js + Express
 * Deploy to: Render.com (free tier) — see SETUP_GUIDE.md
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

// ─── IMPORTANT: raw body for Stripe webhook verification ─────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));

// ─── JSON body for all other routes ──────────────────────────────────────────
app.use(express.json());

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Stock Club backend is running ✅' });
});

// ─── PRICE MAP ───────────────────────────────────────────────────────────────
// These are your Stripe Price IDs — fill in after creating products in Stripe
const PRICE_IDS = {
  monthly:   process.env.STRIPE_PRICE_MONTHLY,    // $49/mo
  quarterly: process.env.STRIPE_PRICE_QUARTERLY,  // $119/3mo
  annual:    process.env.STRIPE_PRICE_ANNUAL,      // $399/yr
  lifetime:  process.env.STRIPE_PRICE_LIFETIME,    // $1,500 one-time
};

// ─── CREATE CHECKOUT SESSION ──────────────────────────────────────────────────
// Frontend calls POST /create-checkout with { plan, telegram_username, email }
app.post('/create-checkout', async (req, res) => {
  const { plan, telegram_username, email, name } = req.body;

  if (!plan || !telegram_username || !email) {
    return res.status(400).json({ error: 'Missing required fields: plan, telegram_username, email' });
  }

  const priceId = PRICE_IDS[plan.toLowerCase()];
  if (!priceId) {
    return res.status(400).json({ error: `Unknown plan: ${plan}. Use monthly, quarterly, annual, or lifetime.` });
  }

  try {
    // Lifetime is a one-time payment; others are subscriptions
    const isLifetime = plan.toLowerCase() === 'lifetime';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: isLifetime ? 'payment' : 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        telegram_username: telegram_username.replace('@', ''), // store without @
        member_name: name || '',
        plan: plan,
      },
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/#pricing`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Stripe calls POST /webhook after every payment event
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  // Verify the event came from Stripe (not a fake request)
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Handle successful payments ──────────────────────────────────────────
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'invoice.payment_succeeded'
  ) {
    const session = event.data.object;

    // Pull the Telegram username we stored in metadata
    const telegramUsername =
      session.metadata?.telegram_username ||
      session.subscription_details?.metadata?.telegram_username;

    const memberName = session.metadata?.member_name || 'Member';
    const plan       = session.metadata?.plan || 'membership';

    if (telegramUsername) {
      await sendTelegramInvite(telegramUsername, memberName, plan);
    } else {
      console.warn('No telegram_username in metadata for session:', session.id);
    }
  }

  // ── Handle subscription cancellations / failed payments ────────────────
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const telegramUsername = subscription.metadata?.telegram_username;
    if (telegramUsername) {
      await notifyMemberCancelled(telegramUsername);
    }
  }

  res.json({ received: true });
});

// ─── TELEGRAM HELPER: Send invite link ───────────────────────────────────────
async function sendTelegramInvite(username, name, plan) {
  try {
    // Create a one-time invite link for the private group
    const invite = await bot.createChatInviteLink(
      process.env.TELEGRAM_GROUP_ID,
      {
        name: `${username}-${Date.now()}`,
        member_limit: 1,          // Single-use link — more secure
        expire_date: Math.floor(Date.now() / 1000) + 86400, // Expires in 24hrs
      }
    );

    const message =
      `🎉 *Welcome to Stock Club, ${name}!*\n\n` +
      `Your *${plan}* membership is confirmed.\n\n` +
      `👇 Click below to join your private group:\n` +
      `${invite.invite_link}\n\n` +
      `_This link is single-use and expires in 24 hours._\n\n` +
      `📈 See you inside!`;

    // Send via bot — user must have messaged the bot first
    // (see SETUP_GUIDE.md for how to handle this)
    await bot.sendMessage(`@${username}`, message, { parse_mode: 'Markdown' });

    console.log(`✅ Telegram invite sent to @${username} for plan: ${plan}`);
  } catch (err) {
    console.error(`❌ Failed to send Telegram invite to @${username}:`, err.message);
    // Don't crash — log it so you can manually add them
  }
}

// ─── TELEGRAM HELPER: Notify on cancellation ─────────────────────────────────
async function notifyMemberCancelled(username) {
  try {
    await bot.sendMessage(
      `@${username}`,
      `Hi! Your Stock Club subscription has ended. Your Telegram access will be removed shortly.\n\nRejoin anytime at stockclub.com 📈`,
    );
    console.log(`Cancellation notice sent to @${username}`);
  } catch (err) {
    console.error(`Could not notify @${username} of cancellation:`, err.message);
  }
}

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Stock Club backend running on port ${PORT}`);
  console.log(`   Stripe webhook endpoint: POST /webhook`);
  console.log(`   Checkout endpoint:       POST /create-checkout\n`);
});
