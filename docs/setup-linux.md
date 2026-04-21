# Linux Setup Guide

Everything in the main README applies — the only differences are how you install TradingView and launch it with CDP enabled.

---

## 1. Install TradingView Desktop

Choose one of the following methods:

**Flatpak (recommended):**
```bash
flatpak install flathub com.tradingview.TradingViewDesktop
```

**Snap:**
```bash
sudo snap install tradingview
```

**AppImage:**
Download from the TradingView website and make it executable:
```bash
chmod +x TradingView-*.AppImage
```

---

## 2. Launch TradingView with CDP enabled

You must launch TradingView with the `--remote-debugging-port=9222` flag.

**Flatpak:**
```bash
flatpak run com.tradingview.TradingViewDesktop --remote-debugging-port=9222
```

**Snap:**
```bash
tradingview --remote-debugging-port=9222
```

**Tip:** Add a shell alias so you don't have to type it every time:
```bash
alias tv="flatpak run com.tradingview.TradingViewDesktop --remote-debugging-port=9222"
```

Add this line to your `~/.bashrc` or `~/.zshrc` to make it permanent.

---

## 3. Configure the MCP

In your Claude Code MCP config at `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "@tradingview/mcp-server"],
      "env": {
        "CDP_PORT": "9222"
      }
    }
  }
}
```

---

## 4. Verify the connection

In Claude Code terminal:

```
tv_health_check
```

If it returns `cdp_connected: true` — you're good. If not:
- Make sure TradingView was launched with the `--remote-debugging-port=9222` flag
- Check port 9222 isn't in use: `ss -tlnp | grep 9222`
- Close and relaunch TradingView with the correct flag

---

## 5. Continue with the main setup

Once `tv_health_check` passes, go back to the [main README](../README.md) and continue from Step 2.
