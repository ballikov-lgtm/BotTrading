# How to update SID to the latest version

Every so often a new, improved version of the SID strategy is published. Updating
means your bot starts running that newer version. You do **not** need to download
anything, type any commands, or know any coding. It is one button.

**Before anything else, the one promise that matters:**

> **Updating NEVER touches your trades, your positions, your account balance, or any
> of your passwords/keys.** It only refreshes the strategy code and the release notes.
> Your money side is completely left alone — every single time.

---

## The one-click way (do this)

This is the same **Actions** tab you already use to run your bot.

1. **Open your bot's page on GitHub.** In your web browser go to
   `github.com/YOUR-USERNAME/YOUR-REPO` (your own copy of the bot).
2. **Click the "Actions" tab** along the top of the page.
3. **On the left-hand list, click "Update SID to latest".**
4. **Click the grey "Run workflow" button** on the right. A little box drops down —
   click the **green "Run workflow"** button inside it to confirm.
5. **Wait about a minute, then refresh the page.** A **green tick** ✅ next to the run
   means it's done. **Your bot now runs the latest version.**

That's it. There is nothing else to do.

If it says **"You're already up to date"**, that just means there was no new version
to pull — nothing was needed and nothing changed. That's a perfectly normal result.

**Your trades and account are never touched by an update.** The updater is built so
that if it ever tried to change one of your live data files (your positions, balance,
trade history, and so on), it stops itself immediately and changes nothing. You cannot
lose a trade or a balance by running it.

---

## How do I know there's a new version to update to?

Two easy ways:

- **Your dashboard.** Open your SID dashboard (the web page at
  `https://YOUR-USERNAME.github.io/YOUR-REPO/sid/`) and look at the **Updates** tab. It
  lists every published version with a short summary of what changed and the date. If
  the newest entry there is newer than the version shown at the top of your dashboard,
  there's an update waiting — run the button above and your dashboard will catch up on
  its next rebuild.
- **Just run it anytime.** You can click **"Update SID to latest"** whenever you like.
  If there's nothing new, it simply tells you you're already up to date and does
  nothing. Running it when you don't need to is completely harmless.

There's no schedule you have to keep. Check in now and then — say once a week, or
whenever you notice a new entry on the Updates tab — and press the button.

---

## What actually happens when I press the button (in plain terms)

The button quietly goes to the original SID project, copies over **only** the strategy
code and the "what changed" notes, and saves them into your copy. It then double-checks
that it hasn't accidentally touched any of your personal data — and if it somehow had,
it throws the whole thing away and leaves you exactly as you were. When it finishes it
shows you a short summary: the new version name, one line about what changed, and a
reminder that your positions, balance, trades, and keys were left alone.

Your **dashboard** will show the new version number and its release notes automatically
the next time it rebuilds (that happens on its own a few times each trading day — or
you can rebuild it now from the Actions tab by running **"SID Dashboard"**).

---

## Advanced / if you use Claude

If you happen to use Claude (an AI assistant) and prefer a guided, step-by-step update
where you can see and approve each command, there's a companion prompt:
**`SID-UPDATE-PROMPT.md`** in this same folder. Paste it into a fresh Claude session and
it walks you through the manual route one step at a time. **You do not need this** — the
one-click button above does the same job for everyone with no tools required. The prompt
is just there for people who want to watch it happen command by command.

---

## Prefer a local double-click instead of the website?

If you'd rather run the update from your own computer with a double-click (instead of
the GitHub website), that can be added — just ask and we'll set up a simple script for
you. For almost everyone the one-click button above is the easiest way, so we haven't
built the local version by default.
