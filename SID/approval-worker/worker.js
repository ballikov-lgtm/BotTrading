/**
 * SID Telegram approval Worker (Cloudflare Workers) — v2.3.0
 *
 * Receives Telegram webhook updates for the SID short-approval flow and, on an
 * authorised [✅ Approve] tap, dispatches the sid-approve-trade.yml GitHub
 * workflow which enters the trade as a PROPERLY TRACKED bot position.
 *
 * ── SECURITY MODEL (every request is authenticated on TWO independent axes) ──
 *   1. Transport secret: Telegram is configured (via setWebhook secret_token) to
 *      send an `X-Telegram-Bot-Api-Secret-Token` header on every webhook POST.
 *      We reject (401) any request whose header !== env.WEBHOOK_SECRET. This
 *      stops anyone who guesses the Worker URL from injecting fake updates.
 *   2. Identity allowlist: we only act on callback queries whose
 *      `callback_query.from.id` === env.ALLOWED_CHAT_ID (Alan's Telegram user
 *      id). Any other user is answered with "Not authorised" and ignored — even
 *      if they somehow reached the bot.
 * Plus: the GitHub token is a FINE-GRAINED, least-privilege token (Actions
 * read+write on the ONE BotTrading repo, nothing else). It lives ONLY as a
 * Worker secret (wrangler secret put) — never in code, never committed.
 *
 * The Worker itself places NO trades and touches NO money. It only dispatches a
 * workflow; the workflow (approve-trade.js) does the trade against Alpaca PAPER.
 *
 * ── Secrets (set via `wrangler secret put <NAME>` — see README.md) ──
 *   TELEGRAM_BOT_TOKEN — bot token, to answer/edit the callback message
 *   WEBHOOK_SECRET     — shared secret echoed by Telegram in the header
 *   ALLOWED_CHAT_ID    — Alan's Telegram numeric user id (only approver)
 *   GITHUB_TOKEN       — fine-grained PAT: Actions RW on BotTrading only
 *   GH_OWNER           — e.g. "ballikov-lgtm"
 *   GH_REPO            — e.g. "BotTrading"
 *
 * Nothing here is a plaintext default — an unset secret makes that check fail
 * closed (we reject rather than fall back to an insecure path).
 */

const WORKFLOW_FILE = 'sid-approve-trade.yml';
const TG_API = 'https://api.telegram.org';

export default {
  async fetch(request, env, ctx) {
    // Only POST (the Telegram webhook). Everything else → 405. A bare GET
    // returns a terse liveness string with NO secret material.
    if (request.method === 'GET') {
      return new Response('SID approval worker: alive. POST-only webhook.', { status: 200 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ── SECURITY CHECK 1: webhook secret header ──────────────────────────────
    // Fail closed if WEBHOOK_SECRET is unset OR the header doesn't match.
    const gotSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!env.WEBHOOK_SECRET || gotSecret !== env.WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // We only handle callback_query updates (button taps). Ignore everything
    // else (plain messages, edited messages, etc.) with a 200 so Telegram
    // doesn't retry.
    const cq = update && update.callback_query;
    if (!cq) return new Response('OK', { status: 200 });

    const fromId = cq.from && cq.from.id != null ? String(cq.from.id) : '';
    const data = typeof cq.data === 'string' ? cq.data : '';
    const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
    const messageId = cq.message ? cq.message.message_id : null;

    // ── SECURITY CHECK 2: identity allowlist ─────────────────────────────────
    // Only Alan's Telegram user id may approve/skip. Anyone else is answered
    // and ignored (no workflow dispatch, no state change).
    if (!env.ALLOWED_CHAT_ID || fromId !== String(env.ALLOWED_CHAT_ID)) {
      ctx.waitUntil(answerCallback(env, cq.id, 'Not authorised.'));
      return new Response('OK', { status: 200 });
    }

    // ── Parse callback_data: `approve:<id>` | `skip:<id>` ────────────────────
    const sep = data.indexOf(':');
    const action = sep >= 0 ? data.slice(0, sep) : data;
    const approvalId = sep >= 0 ? data.slice(sep + 1) : '';

    if (action === 'skip') {
      ctx.waitUntil(Promise.all([
        answerCallback(env, cq.id, 'Skipped.'),
        editMessage(env, chatId, messageId, `❌ <b>Skipped</b> — <code>${escapeHtml(approvalId)}</code> dismissed.`),
      ]));
      return new Response('OK', { status: 200 });
    }

    if (action === 'approve') {
      if (!approvalId) {
        ctx.waitUntil(answerCallback(env, cq.id, 'Missing approval id.'));
        return new Response('OK', { status: 200 });
      }
      // Dispatch the GitHub workflow. Do the network work in waitUntil so the
      // webhook returns promptly (Telegram expects a fast 200).
      ctx.waitUntil((async () => {
        const res = await dispatchWorkflow(env, approvalId);
        if (res.ok) {
          await Promise.all([
            answerCallback(env, cq.id, 'Approved — firing…'),
            editMessage(env, chatId, messageId, `✅ <b>Approved — firing…</b>\n<code>${escapeHtml(approvalId)}</code> dispatched to sid-approve-trade.yml.`),
          ]);
        } else {
          await Promise.all([
            answerCallback(env, cq.id, `Dispatch failed (${res.status}).`),
            editMessage(env, chatId, messageId, `⚠️ <b>Approval dispatch FAILED</b> for <code>${escapeHtml(approvalId)}</code> (HTTP ${res.status}). ${escapeHtml(res.detail || '')}`),
          ]);
        }
      })());
      return new Response('OK', { status: 200 });
    }

    // Unknown action — acknowledge so the spinner clears, do nothing else.
    ctx.waitUntil(answerCallback(env, cq.id, 'Unknown action.'));
    return new Response('OK', { status: 200 });
  },
};

// ── GitHub REST: workflow_dispatch ──────────────────────────────────────────
async function dispatchWorkflow(env, approvalId) {
  if (!env.GITHUB_TOKEN || !env.GH_OWNER || !env.GH_REPO) {
    return { ok: false, status: 0, detail: 'GitHub env not configured' };
  }
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization':        `Bearer ${env.GITHUB_TOKEN}`,
        'Accept':               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':           'sid-approval-worker',
        'Content-Type':         'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { approval_id: approvalId } }),
    });
    // 204 No Content == success for workflow_dispatch.
    if (res.status === 204) return { ok: true, status: 204 };
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: detail.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, detail: String(err && err.message || err) };
  }
}

// ── Telegram helpers (best-effort; failures don't throw) ─────────────────────
async function answerCallback(env, callbackQueryId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch { /* best effort */ }
}

async function editMessage(env, chatId, messageId, html) {
  if (!env.TELEGRAM_BOT_TOKEN || chatId == null || messageId == null) return;
  try {
    await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        // Drop the keyboard so the buttons can't be tapped twice.
        reply_markup: { inline_keyboard: [] },
      }),
    });
  } catch { /* best effort */ }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
