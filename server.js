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
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

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
  monthly:        process.env.STRIPE_PRICE_MONTHLY,
  quarterly:      process.env.STRIPE_PRICE_QUARTERLY,
  annual:         process.env.STRIPE_PRICE_ANNUAL,
  lifetime:       process.env.STRIPE_PRICE_LIFETIME,
  legacy_monthly: process.env.STRIPE_PRICE_LEGACY_MONTHLY,  // $5/mo
  annual_legacy:  process.env.STRIPE_PRICE_LEGACY_ANNUAL,   // $60/yr
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
      success_url: `${process.env.FRONTEND_URL}/?success=true`,
      cancel_url:  `${process.env.FRONTEND_URL}/`,
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

// ─── BOT COMMAND HANDLER ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || 'there';
  const text   = (msg.text || '').toLowerCase().trim();

  // ── /start or hi/hello ──────────────────────────────────────────────────
  if (text === '/start' || text === 'hi' || text === 'hello' || text === 'hey') {
    return bot.sendMessage(chatId,
      `👋 Hey ${name}! Welcome to *Stock Club* 📈\n\n` +
      `Here's what I can do for you:\n\n` +
      `📊 *status* — Check your subscription & days remaining\n` +
      `🔄 *renew* — Upgrade or renew your membership\n` +
      `❓ *help* — Show this menu\n\n` +
      `If you just paid, your invite link is coming within 60 seconds!`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── help ────────────────────────────────────────────────────────────────
  if (text === 'help' || text === '/help') {
    return bot.sendMessage(chatId,
      `🤖 *Stock Club Bot Commands*\n\n` +
      `📊 *status* — View your plan & expiry date\n` +
      `🔄 *renew* — Get a link to renew or upgrade\n` +
      `❓ *help* — Show this menu\n\n` +
      `Questions? DM @ra1phie directly 💬`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── renew ───────────────────────────────────────────────────────────────
  if (text === 'renew' || text === '/renew') {
    return bot.sendMessage(chatId,
      `🔄 *Renew or Upgrade Your Membership*\n\n` +
      `Click below to visit the membership page:\n` +
      `👉 https://stockclubvip.com\n\n` +
      `_Already a legacy member? Use the Legacy Members link at the bottom of the page._`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── status ──────────────────────────────────────────────────────────────
  if (text === 'status' || text === '/status') {
    await bot.sendMessage(chatId, `🔍 Looking up your subscription...`);

    try {
      const tgUsername = msg.from.username;
      const tgUserId   = String(msg.from.id);

      // Search Stripe customers — match by telegram_username in metadata
      const subscriptions = await stripe.subscriptions.list({ limit: 100, status: 'active', expand: ['data.customer'] });

      let found = null;
      for (const sub of subscriptions.data) {
        const meta = sub.metadata?.telegram_username || '';
        if (
          meta === tgUsername ||
          meta === tgUserId ||
          meta === `@${tgUsername}`
        ) {
          found = sub;
          break;
        }
      }

      // Also check one-time lifetime payments
      if (!found) {
        const sessions = await stripe.checkout.sessions.list({ limit: 100 });
        for (const s of sessions.data) {
          const meta = s.metadata?.telegram_username || '';
          if (
            (meta === tgUsername || meta === tgUserId || meta === `@${tgUsername}`) &&
            s.metadata?.plan?.toLowerCase() === 'lifetime' &&
            s.payment_status === 'paid'
          ) {
            return bot.sendMessage(chatId,
              `🏆 *Lifetime Member*\n\n` +
              `You have *unlimited access — forever!*\n\n` +
              `Never billed again. You're set for life 🎉`,
              { parse_mode: 'Markdown' }
            );
          }
        }
      }

      if (!found) {
        return bot.sendMessage(chatId,
          `❌ *No active subscription found*\n\n` +
          `I couldn't find an account linked to your Telegram.\n\n` +
          `If you think this is an error, DM @ra1phie 💬\n\n` +
          `Or join at 👉 https://stockclubvip.com`,
          { parse_mode: 'Markdown' }
        );
      }

      // Calculate days remaining
      const now          = Math.floor(Date.now() / 1000);
      const periodEnd    = found.current_period_end;
      const daysLeft     = Math.ceil((periodEnd - now) / 86400);
      const renewDate    = new Date(periodEnd * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const planNickname = found.metadata?.plan || found.items?.data[0]?.price?.nickname || 'Membership';
      const amount       = (found.items?.data[0]?.price?.unit_amount / 100).toFixed(2);
      const interval     = found.items?.data[0]?.price?.recurring?.interval || 'month';

      const statusEmoji = daysLeft <= 7 ? '⚠️' : '✅';

      return bot.sendMessage(chatId,
        `${statusEmoji} *Your Stock Club Subscription*\n\n` +
        `📋 Plan: *${planNickname}*\n` +
        `💰 Amount: *$${amount}/${interval}*\n` +
        `📅 Renews: *${renewDate}*\n` +
        `⏳ Days remaining: *${daysLeft} days*\n\n` +
        `${daysLeft <= 7 ? '⚠️ _Your subscription renews soon!_\n\nType *renew* to manage your plan.' : '📈 Keep watching those signals!'}`,
        { parse_mode: 'Markdown' }
      );

    } catch (err) {
      console.error('Status lookup error:', err.message);
      return bot.sendMessage(chatId,
        `⚠️ Something went wrong looking up your account. Please try again or DM @ra1phie.`
      );
    }
  }

  // ── Default response ────────────────────────────────────────────────────
  return bot.sendMessage(chatId,
    `👋 Hey ${name}! Thanks for reaching out to Stock Club.\n\n` +
    `Type *help* to see what I can do for you 📈`,
    { parse_mode: 'Markdown' }
  );
});


const pendingInvites = {};

// ─── TELEGRAM HELPER: Send invite link with retry ────────────────────────────
async function sendTelegramInvite(username, name, plan, retryCount = 0) {
  try {
    // Create a one-time invite link for the private group
    const invite = await bot.createChatInviteLink(
      process.env.TELEGRAM_GROUP_ID,
      {
        name: `${username}-${Date.now()}`,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 604800, // Expires in 7 days
      }
    );

    const message =
      `🎉 *Welcome to Stock Club, ${name}!*\n\n` +
      `Your *${plan}* membership is confirmed.\n\n` +
      `👇 Click below to join your private group:\n` +
      `${invite.invite_link}\n\n` +
      `_This link is single-use and expires in 7 days._\n\n` +
      `📈 See you inside!`;

    // Use numeric ID if provided (more reliable), otherwise use @username
    const chatId = username.match(/^\d+$/) ? parseInt(username) : `@${username}`;
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    console.log(`✅ Telegram invite sent to ${chatId} for plan: ${plan}`);

    // Clear from pending if it was stored
    delete pendingInvites[username];

  } catch (err) {
    console.error(`❌ Failed to send Telegram invite to @${username}:`, err.message);

    if (retryCount < 5) {
      pendingInvites[username] = { username, name, plan, retryCount };
      const delay = (retryCount + 1) * 2 * 60 * 1000;
      console.log(`⏳ Will retry sending to @${username} in ${(retryCount + 1) * 2} minutes (attempt ${retryCount + 1}/5)`);
      setTimeout(() => sendTelegramInvite(username, name, plan, retryCount + 1), delay);
    } else {
      console.error(`🚨 MANUAL ACTION NEEDED: Could not reach @${username} after 5 attempts.`);
    }
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

// ─── MANUAL RETRY ENDPOINT ───────────────────────────────────────────────────
// Call POST /retry-invite with { username, name, plan } to manually resend
app.post('/retry-invite', async (req, res) => {
  const { username, name, plan } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  console.log(`🔄 Manual retry triggered for @${username}`);
  await sendTelegramInvite(username, name || 'Member', plan || 'membership', 0);
  res.json({ message: `Retry triggered for @${username}` });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Stock Club backend running on port ${PORT}`);
  console.log(`   Stripe webhook endpoint: POST /webhook`);
  console.log(`   Checkout endpoint:       POST /create-checkout\n`);
});
