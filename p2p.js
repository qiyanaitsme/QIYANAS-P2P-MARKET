import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

const { token, forum_id, state, order } = config.lolzteam;
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const excludedThreadIds = [8607648, 9140479, 8573082, 9305988, 8111558];

const BANKS_BY_COUNTRY = {
  '🇷🇺 Россия': ['СБП', 'Т-Банк', 'Сбербанк', 'Альфа-банк', 'ВТБ Банк', 'Райффайзенбанк', 'МТС Банк', 'Россельхозбанк', 'Газпромбанк', 'Совкомбанк', 'Промсвязьбанк', 'ЮMoney', 'QIWI'],
  '🇺🇦 Украина': ['ПриватБанк', 'Monobank', 'PUMB', 'Ощадбанк', 'A-Bank', 'Райффайзенбанк (Украина)', 'IziBank', 'AccordBank'],
  '🇰🇿 Казахстан': ['Kaspi Bank', 'Halyk Bank', 'ЦентрКредит Банк', 'Jysan Bank', 'Forte Bank', 'Altyn Bank', 'Bank RBK', 'Bereke Bank'],
  '🇧🇾 Беларусь': ['Альфа-Банк (Беларусь)', 'МТБанк', 'Приорбанк', 'Паритетбанк', 'CashU', 'Банк Решение', 'БСБ Банк', 'БТА Банк', 'Статусбанк', 'Беларусбанк'],
  '💎 Криптовалюта': ['CryptoBot']
};

const BANKS = Object.values(BANKS_BY_COUNTRY).flat();

const apiOptions = {
  method: 'GET',
  headers: {
    accept: 'application/json',
    authorization: `Bearer ${token}`
  }
};

async function sendToTelegram(threads) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID || threads.length === 0) return;

  const getType = (parsed) => {
    if (parsed?.toMethod?.toLowerCase().includes('маркет')) return 'DEPOSIT';
    if (parsed?.fromMethod?.toLowerCase().includes('маркет')) return 'WITHDRAW';
    return 'OTHER';
  };

  const chunks = [];
  for (let i = 0; i < threads.length; i += 5) {
    chunks.push(threads.slice(i, i + 5));
  }


  for (const chunk of chunks) {
    const text = chunk.map(t => {
      const type = getType(t.parsed);
      const date = new Date(t.thread_create_date * 1000).toLocaleString('ru-RU');
      return `<b>[${type}]</b>\n<code>${t.thread_title}</code>\n\nAuthor: <b>${t.creator_username}</b>\nDate: ${date}\nLink: <a href="https://lolz.live/threads/${t.thread_id}/">Thread #${t.thread_id}</a>`;
    }).join('\n\n━━━━━━━━━━━━━━━\n\n');

    const header = `<b>QIYANAS P2P PARSER</b>\n<i>Lolzteam Market Exchange</i>\n\n━━━━━━━━━━━━━━━\n\n`;

    try {
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text: header + text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      await sleep(100);
    } catch (e) {
      console.error('Telegram error:', e.message);
    }
  }
}

function parseTitle(title) {
  const match = title.match(/\[([^\]]+)\]\s*(.+)/);
  if (!match) return null;

  const amounts = match[1];
  const direction = match[2];

  const amountMatch = amounts.match(/([\d\s.,]+)\s*(\w+)\s*>\s*([\d\s.,]+)\s*(\w+)/i);
  const fromAmount = amountMatch ? parseFloat(amountMatch[1].replace(/\s/g, '').replace(',', '.')) : null;
  const toAmount = amountMatch ? parseFloat(amountMatch[3].replace(/\s/g, '').replace(',', '.')) : null;

  const dirMatch = direction.match(/(.+?)\s*>\s*(.+)/);
  const fromMethod = dirMatch ? dirMatch[1].trim() : null;
  const toMethod = dirMatch ? dirMatch[2].trim() : null;

  return { fromAmount, toAmount, fromMethod, toMethod };
}

function matchesFilters(thread, filters) {
  const parsed = parseTitle(thread.thread_title);
  if (!parsed) return false;

  const { fromAmount, toAmount, fromMethod, toMethod } = parsed;

  if (filters.direction === 'deposit' && !toMethod?.toLowerCase().includes('маркет')) return false;
  if (filters.direction === 'withdraw' && !fromMethod?.toLowerCase().includes('маркет')) return false;

  if (filters.bank) {
    const bankLower = filters.bank.toLowerCase();
    if (!fromMethod?.toLowerCase().includes(bankLower) && !toMethod?.toLowerCase().includes(bankLower)) return false;
  }

  if (filters.minGive && fromAmount < filters.minGive) return false;
  if (filters.maxGive && fromAmount > filters.maxGive) return false;
  if (filters.minGet && toAmount < filters.minGet) return false;
  if (filters.maxGet && toAmount > filters.maxGet) return false;

  return true;
}

async function fetchPage(page) {
  const res = await fetch(
    `https://prod-api.lolz.live/threads?forum_id=${forum_id}&state=${state}&order=${order}&page=${page}`,
    apiOptions
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

app.get('/api/banks', (_req, res) => {
  res.json({ grouped: BANKS_BY_COUNTRY, flat: BANKS });
});

app.post('/api/parse', async (req, res) => {
  const { pages = 50, filters = {}, delay = 200 } = req.body;
  const maxPages = Math.min(Math.max(1, pages), 100);

  try {
    const allThreads = [];

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(delay);
      const data = await fetchPage(page);

      const threads = (data.threads || [])
        .filter(thread => !excludedThreadIds.includes(thread.thread_id))
        .filter(thread => matchesFilters(thread, filters))
        .map(thread => ({
          thread_id: thread.thread_id,
          thread_title: thread.thread_title,
          creator_username: thread.creator_username,
          thread_create_date: thread.thread_create_date,
          parsed: parseTitle(thread.thread_title)
        }));

      allThreads.push(...threads);
    }

    allThreads.sort((a, b) => b.thread_create_date - a.thread_create_date);
    await sendToTelegram(allThreads);

    res.json({ success: true, threads: allThreads, total: allThreads.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`P2P Parser: http://localhost:${PORT}`);
});
