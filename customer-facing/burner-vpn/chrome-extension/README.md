# Burner Tab Relay Extension

1. Open chrome://extensions in Chrome.
2. Turn on Developer mode.
3. Click Load unpacked and choose this folder.
4. Open the extension popup.
5. Paste the Dashboard URL, Username, and Password from the burner-vpn host output or dashboard.
6. Click Attach Current Tab.

What it does:

The extension attaches to the current tab with the Chrome debugger Fetch domain, intercepts HTTP and HTTPS requests, and relays them through the sandbox over WebSocket. Because it stays in your existing Chrome profile, cookies and logged-in sessions in that tab are preserved.

Current limitations:

WebSocket upgrades and large binary uploads are not tunneled yet.