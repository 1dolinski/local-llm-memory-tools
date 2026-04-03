import { Bot } from 'grammy';
import { vlog } from './log.js';
import { getDb } from './db.js';

export type ChatFn = (message: string, reply: (text: string) => void) => Promise<void>;

let _chatFn: ChatFn | null = null;

export function setTelegramChatFn(fn: ChatFn): void {
  _chatFn = fn;
}

export async function startTelegramBot(token: string): Promise<void> {
  const bot = new Bot(token);

  bot.command('start', (ctx) => ctx.reply('Connected to Hammock AI. Send any message to chat.'));
  bot.command('tasks', (ctx) => handleSlash(ctx, '/tasks'));
  bot.command('memory', (ctx) => handleSlash(ctx, '/memory'));
  bot.command('qmd', (ctx) => handleSlash(ctx, '/qmd'));
  bot.command('clear', (ctx) => handleSlash(ctx, '/clear'));

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;

    upsertChatState(chatId);
    vlog('telegram', `message from ${chatId}: ${text.slice(0, 100)}`);

    if (!_chatFn) {
      await ctx.reply('Chat function not ready yet.');
      return;
    }

    let buffer = '';
    const flush = async () => {
      if (buffer.length > 0) {
        await ctx.reply(buffer);
        buffer = '';
      }
    };

    try {
      await _chatFn(text, (chunk: string) => {
        buffer += chunk;
      });
      await flush();
    } catch (err: any) {
      vlog('telegram', `error: ${err.message}`);
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.catch((err) => {
    vlog('telegram', `bot error: ${err.message}`);
  });

  console.log('  Telegram bot started (polling)');
  await bot.start();
}

function handleSlash(ctx: any, command: string): void {
  if (!_chatFn) {
    ctx.reply('Not ready.');
    return;
  }
  _chatFn(command, (chunk: string) => {
    ctx.reply(chunk);
  });
}

function upsertChatState(chatId: string): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO telegram_state (chat_id) VALUES (?)
         ON CONFLICT(chat_id) DO UPDATE SET last_message_id = datetime('now')`
      )
      .run(chatId);
  } catch {
    // DB might not be initialized if telegram-only — safe to ignore
  }
}
