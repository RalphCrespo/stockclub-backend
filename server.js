require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const TelegramBot = require('node-telegram-bot-api');

const app = express();

// ─── TELEGRAM: Use webhook mode instead of polling (fixes 409 conflict) ───────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { webHook: false });

// Set the webhook URL once on startup
const TELEGRAM_WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL || 'https://stockclub-backend.onrender.com'}/telegram-webhook`;
bot.setWebHook(TELEGRAM_WEBHOOK_URL).then(() => {
  console.log(`✅ Telegram webhook set to: ${TELEGRAM_WEBHOOK_URL}`);
}).catch(err => {
  console.error('Failed to set Telegram webhook:', err.message);
});

// ─── PENDING INVITES (declare early so all functions can access it) ───────────
const pendingInvites = {};

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());

// ─── RAW BODY for Stripe webhook ──────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Stock Club backend running ✅' }));

// ─── TELEGRAM WEBHOOK ENDPOINT ────────────────────────────────────────────────
app.post('/telegram-webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ─── PRICE MAP ────────────────────────────────────────────────────────────────
const PRICE_IDS = {
  monthly:        process.env.STRIPE_PRICE_MONTHLY,
  quarterly:      process.env.STRIPE_PRICE_QUARTERLY,
  annual:         process.env.STRIPE_PRICE_ANNUAL,
  lifetime:       process.env.STRIPE_PRICE_LIFETIME,
  legacy_monthly: process.env.STRIPE_PRICE_LEGACY_MONTHLY,
  annual_legacy:  process.env.STRIPE_PRICE_LEGACY_ANNUAL,
};

// ─── CREATE CHECKOUT ──────────────────────────────────────────────────────────
app.post('/create-checkout', async (req, res) => {
  const { plan, telegram_username, email, name } = req.body;
  if (!plan || !telegram_username || !email)
    return res.status(400).json({ error: 'Missing required fields' });

  const priceId = PRICE_IDS[plan.toLowerCase()];
  if (!priceId)
    return res.status(400).json({ error: `Unknown plan: ${plan}` });

  try {
    const isLifetime    = plan.toLowerCase() === 'lifetime';
    const cleanUsername = telegram_username.replace('@', '').toLowerCase();

    const meta = {
      telegram_username: cleanUsername,
      member_name: name || '',
      plan: plan,
    };

    const sessionParams = {
      payment_method_types: ['card'],
      mode: isLifetime ? 'payment' : 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: meta,
      success_url: `${process.env.FRONTEND_URL}/?success=true`,
      cancel_url:  `${process.env.FRONTEND_URL}/`,
    };

    // ── KEY FIX: pass metadata directly to subscription at creation time ──
    // This ensures telegram_username is on the subscription immediately,
    // not dependent on webhook timing
    if (!isLifetime) {
      sessionParams.subscription_data = { metadata: meta };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── REPAIR ENDPOINT: Fix all subscriptions missing telegram metadata ─────────
// Call GET /repair-metadata to scan and fix all broken subscriptions
app.get('/repair-metadata', async (req, res) => {
  try {
    let fixed = 0; let skipped = 0; const errors = [];

    // Get all checkout sessions
    const sessions = await stripe.checkout.sessions.list({ limit: 100 });

    for (const s of sessions.data) {
      const tg   = s.metadata?.telegram_username;
      const subId = s.subscription;
      if (!tg || !subId) { skipped++; continue; }

      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        if (!sub.metadata?.telegram_username) {
          await stripe.subscriptions.update(subId, {
            metadata: {
              telegram_username: tg,
              member_name: s.metadata?.member_name || '',
              plan: s.metadata?.plan || '',
            }
          });
          console.log(`🔧 Fixed metadata for @${tg} on sub ${subId}`);
          fixed++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors.push({ subId, error: err.message });
      }
    }

    res.json({ message: `Done! Fixed: ${fixed}, Skipped: ${skipped}, Errors: ${errors.length}`, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── checkout.session.completed ─────────────────────────────────────────
  // Fires when customer completes Stripe checkout (first payment)
  if (event.type === 'checkout.session.completed') {
    const session          = event.data.object;
    const telegramUsername = session.metadata?.telegram_username;
    const memberName       = session.metadata?.member_name || 'Member';
    const plan             = session.metadata?.plan || 'membership';

    console.log(`📦 Checkout completed — telegram: ${telegramUsername}, plan: ${plan}`);

    // Copy metadata to subscription so bot status lookups work
    if (session.subscription && telegramUsername) {
      try {
        await stripe.subscriptions.update(session.subscription, {
          metadata: { telegram_username: telegramUsername, member_name: memberName, plan }
        });
        console.log(`✅ Subscription metadata saved for @${telegramUsername}`);
      } catch (err) {
        console.error('Failed to update subscription metadata:', err.message);
      }
    }

    if (telegramUsername) {
      await sendTelegramInvite(telegramUsername, memberName, plan);
    } else {
      console.warn('⚠️ No telegram_username in checkout metadata — session:', session.id);
    }
  }

  // ── invoice.payment_succeeded ──────────────────────────────────────────
  // Fires on every recurring renewal — re-save metadata just in case
  if (event.type === 'invoice.payment_succeeded') {
    const invoice          = event.data.object;
    const subscriptionId   = invoice.subscription;
    const telegramUsername = invoice.subscription_details?.metadata?.telegram_username
                          || invoice.metadata?.telegram_username;
    const memberName       = invoice.subscription_details?.metadata?.member_name || 'Member';
    const plan             = invoice.subscription_details?.metadata?.plan || 'membership';

    console.log(`💳 Renewal payment — telegram: ${telegramUsername}, sub: ${subscriptionId}`);

    // Re-save metadata on renewal in case it was missing
    if (subscriptionId && telegramUsername) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        if (!sub.metadata?.telegram_username) {
          await stripe.subscriptions.update(subscriptionId, {
            metadata: { telegram_username: telegramUsername, member_name: memberName, plan }
          });
          console.log(`✅ Renewal metadata saved for @${telegramUsername}`);
        }
      } catch (err) {
        console.error('Failed to update renewal metadata:', err.message);
      }
    }
  }

  // ── customer.subscription.deleted ─────────────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub      = event.data.object;
    const username = sub.metadata?.telegram_username;
    if (username) await notifyMemberCancelled(username);
  }

  res.json({ received: true });
});

// ─── MANUAL RETRY ENDPOINT ────────────────────────────────────────────────────
app.post('/retry-invite', async (req, res) => {
  const { username, name, plan } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  await sendTelegramInvite(username, name || 'Member', plan || 'membership', 0);
  res.json({ message: `Retry triggered for ${username}` });
});

// ─── SHARED MENU ──────────────────────────────────────────────────────────────
const mainMenu = {
  parse_mode: 'Markdown',
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📊 My Status',      callback_data: 'status'      },
        { text: '🔗 Link Account',   callback_data: 'link_prompt' },
      ],
      [
        { text: '🔄 Renew / Upgrade', callback_data: 'renew' },
        { text: '❓ Help',            callback_data: 'help'  },
      ]
    ]
  }
};

// ─── BOT MESSAGE HANDLER ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || 'there';
  const text   = (msg.text || '').toLowerCase().trim();

  // /start, hi, hello
  if (['hi','hello','hey','/start'].includes(text)) {
    return bot.sendMessage(chatId,
      `👋 Hey ${name}! Welcome to *Stock Club* 📈\n\nWhat would you like to do?`,
      mainMenu
    );
  }

  // help
  if (text === 'help' || text === '/help') {
    return bot.sendMessage(chatId,
      `🤖 *Stock Club Bot Commands*\n\n` +
      `📊 *status* — View your plan & days remaining\n` +
      `🔗 *link your@email.com* — Connect your email to your account\n` +
      `🔄 *renew* — Renew or upgrade your plan\n` +
      `❓ *help* — Show this menu\n\n` +
      `Questions? DM @ra1phie 💬`,
      mainMenu
    );
  }

  // renew
  if (text === 'renew' || text === '/renew') {
    return bot.sendMessage(chatId,
      `🔄 *Renew or Upgrade Your Membership*\n\n` +
      `👉 https://stockclubvip.com\n\n` +
      `_Legacy member? Use the Legacy Members link at the bottom of the page._`,
      { parse_mode: 'Markdown' }
    );
  }

  // status
  if (text === 'status' || text === '/status') {
    return handleStatus(chatId, msg.from);
  }

  // link email@example.com
  if (text.startsWith('link ') || text.startsWith('/link ')) {
    const email = text.replace('/link','').replace('link','').trim().toLowerCase();
    return handleLink(chatId, msg.from, email);
  }

  // default
  return bot.sendMessage(chatId,
    `👋 Hey ${name}! What would you like to do?`,
    mainMenu
  );
});

// ─── INLINE BUTTON HANDLER ────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id);

  if (query.data === 'help') {
    return bot.sendMessage(chatId,
      `🤖 *Stock Club Bot Commands*\n\n` +
      `📊 *status* — View your plan & days remaining\n` +
      `🔗 *link your@email.com* — Connect your email\n` +
      `🔄 *renew* — Renew or upgrade your plan\n\n` +
      `Questions? DM @ra1phie 💬`,
      mainMenu
    );
  }

  if (query.data === 'renew') {
    return bot.sendMessage(chatId,
      `🔄 *Renew or Upgrade*\n\n👉 https://stockclubvip.com\n\n_Legacy member? Use the link at the bottom of the page._`,
      { parse_mode: 'Markdown' }
    );
  }

  if (query.data === 'link_prompt') {
    return bot.sendMessage(chatId,
      `🔗 *Link Your Account*\n\n` +
      `Type your email like this:\n\`link your@email.com\`\n\n` +
      `Use the email you used when you first paid 📧`,
      { parse_mode: 'Markdown' }
    );
  }

  if (query.data === 'status') {
    return handleStatus(chatId, query.from);
  }
});

// ─── HELPER: Status lookup ────────────────────────────────────────────────────
async function handleStatus(chatId, from) {
  await bot.sendMessage(chatId, `🔍 Looking up your subscription...`);
  try {
    const tgUsername = (from.username || '').toLowerCase();
    const tgUserId   = String(from.id);

    // Generate username variants swapping l↔1 to handle ambiguity
    const usernameVariants = new Set([
      tgUsername,
      tgUsername.replace(/1/g, 'l'),
      tgUsername.replace(/l/g, '1'),
    ]);

    const subscriptions = await stripe.subscriptions.list({ limit: 100, status: 'active' });
    let found = null;
    for (const sub of subscriptions.data) {
      const meta = (sub.metadata?.telegram_username || '').toLowerCase().replace('@','');
      if (usernameVariants.has(meta) || meta === tgUserId) { found = sub; break; }
    }

    // Check lifetime payments
    if (!found) {
      const sessions = await stripe.checkout.sessions.list({ limit: 100 });
      for (const s of sessions.data) {
        const meta = (s.metadata?.telegram_username || '').toLowerCase().replace('@','');
        if ((usernameVariants.has(meta) || meta === tgUserId) &&
            s.metadata?.plan?.toLowerCase() === 'lifetime' && s.payment_status === 'paid') {
          return bot.sendMessage(chatId,
            `🏆 *Lifetime Member*\n\nYou have *unlimited access — forever!* 🎉\n\nNever billed again. You're set for life.`,
            mainMenu
          );
        }
      }
    }

    if (!found) {
      return bot.sendMessage(chatId,
        `❌ *No active subscription found*\n\n` +
        `Link your account first:\n\`link your@email.com\`\n\n` +
        `Or join at 👉 https://stockclubvip.com`,
        mainMenu
      );
    }

    const now       = Math.floor(Date.now() / 1000);
    const daysLeft  = Math.ceil((found.current_period_end - now) / 86400);
    const renewDate = new Date(found.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const plan      = found.metadata?.plan || found.items?.data[0]?.price?.nickname || 'Membership';
    const amount    = (found.items?.data[0]?.price?.unit_amount / 100).toFixed(2);
    const interval  = found.items?.data[0]?.price?.recurring?.interval || 'month';

    return bot.sendMessage(chatId,
      `${daysLeft <= 7 ? '⚠️' : '✅'} *Your Stock Club Subscription*\n\n` +
      `📋 Plan: *${plan}*\n💰 Amount: *$${amount}/${interval}*\n📅 Renews: *${renewDate}*\n⏳ Days remaining: *${daysLeft} days*\n\n` +
      `${daysLeft <= 7 ? '⚠️ _Renewing soon!_' : '📈 Keep watching those signals!'}`,
      mainMenu
    );
  } catch (err) {
    console.error('Status error:', err.message);
    return bot.sendMessage(chatId, `⚠️ Something went wrong. Please try again or DM @ra1phie.`);
  }
}

// ─── HELPER: Link email to Telegram ──────────────────────────────────────────
async function handleLink(chatId, from, email) {
  if (!email.includes('@') || !email.includes('.')) {
    return bot.sendMessage(chatId,
      `⚠️ *Invalid email*\n\nUsage: \`link your@email.com\``,
      { parse_mode: 'Markdown' }
    );
  }

  await bot.sendMessage(chatId, `🔍 Looking up *${email}*...`, { parse_mode: 'Markdown' });

  try {
    const customers = await stripe.customers.list({ email, limit: 5 });
    if (!customers.data.length) {
      return bot.sendMessage(chatId,
        `❌ *No account found* for \`${email}\`\n\nMake sure this is the email you used to pay.\nDM @ra1phie if you need help 💬`,
        { parse_mode: 'Markdown' }
      );
    }

    const customer = customers.data[0];
    const subs     = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 5 });

    if (!subs.data.length) {
      return bot.sendMessage(chatId,
        `❌ *No active subscription* for \`${email}\`\n\nDM @ra1phie if you think this is an error 💬`,
        { parse_mode: 'Markdown' }
      );
    }

    const sub        = subs.data[0];
    const tgUsername = (from.username || String(from.id)).toLowerCase();

    await stripe.subscriptions.update(sub.id, {
      metadata: { ...sub.metadata, telegram_username: tgUsername }
    });

    const daysLeft  = Math.ceil((sub.current_period_end - Math.floor(Date.now() / 1000)) / 86400);
    const renewDate = new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const plan      = sub.metadata?.plan || sub.items?.data[0]?.price?.nickname || 'Membership';

    return bot.sendMessage(chatId,
      `✅ *Account linked successfully!*\n\n` +
      `📧 Email: \`${email}\`\n📋 Plan: *${plan}*\n📅 Renews: *${renewDate}*\n⏳ Days remaining: *${daysLeft} days*\n\n` +
      `Type *status* anytime to check your subscription 📈`,
      mainMenu
    );
  } catch (err) {
    console.error('Link error:', err.message);
    return bot.sendMessage(chatId, `⚠️ Something went wrong. Please try again or DM @ra1phie.`);
  }
}

// ─── TELEGRAM HELPER: Send invite link ───────────────────────────────────────
async function sendTelegramInvite(username, name, plan, retryCount = 0) {
  try {
    const invite = await bot.createChatInviteLink(process.env.TELEGRAM_GROUP_ID, {
      name: `${username}-${Date.now()}`,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 604800,
    });

    const message =
      `🎉 Welcome to Stock Club, ${name}!\n\n` +
      `Your ${plan} membership is confirmed.\n\n` +
      `👇 Click below to join your private group:\n${invite.invite_link}\n\n` +
      `This link is single-use and expires in 7 days.\n\n📈 See you inside!`;

    const chatId = username.match(/^\d+$/) ? parseInt(username) : `@${username}`;
    await bot.sendMessage(chatId, message);
    console.log(`✅ Telegram invite sent to ${chatId} for plan: ${plan}`);
    delete pendingInvites[username];

  } catch (err) {
    console.error(`❌ Failed to send invite to ${username}:`, err.message);
    if (retryCount < 5) {
      pendingInvites[username] = { username, name, plan, retryCount };
      const delay = (retryCount + 1) * 2 * 60 * 1000;
      console.log(`⏳ Retry ${retryCount + 1}/5 for ${username} in ${(retryCount + 1) * 2} mins`);
      setTimeout(() => sendTelegramInvite(username, name, plan, retryCount + 1), delay);
    } else {
      console.error(`🚨 MANUAL ACTION NEEDED: Could not reach ${username} after 5 attempts.`);
    }
  }
}

// ─── TELEGRAM HELPER: Notify cancellation ────────────────────────────────────
async function notifyMemberCancelled(username) {
  try {
    const chatId = username.match(/^\d+$/) ? parseInt(username) : `@${username}`;
    await bot.sendMessage(chatId,
      `Hi! Your Stock Club subscription has ended.\n\nRejoin anytime at https://stockclubvip.com 📈`
    );
    console.log(`Cancellation notice sent to ${username}`);
  } catch (err) {
    console.error(`Could not notify ${username} of cancellation:`, err.message);
  }
}

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Stock Club backend running on port ${PORT}`);
  console.log(`   Stripe webhook: POST /webhook`);
  console.log(`   Checkout:       POST /create-checkout\n`);
});
