# CoPad.

A shared writing room with a warm retro editor, light and dark themes, rich text formatting, custom text and highlight colors, live cursors, local room history, PDF export, and optional typewriter key sounds.

## Start CoPad and invite friends

1. Double-click `start.bat` in this folder.
2. The launcher starts the local web server and an ngrok HTTPS tunnel, then opens CoPad and prints the public URL.
3. In CoPad, create or open a room, select **Share room**, and copy the room link to send to friends.
4. Keep the launcher and ngrok windows open while everyone is using the room. Closing the ngrok tunnel ends the public link.

The first time a visitor opens a free ngrok link, ngrok may show its own **Visit Site** confirmation. That is ngrok's free-tier interstitial; each visitor needs to accept it once for that tunnel domain. CoPad cannot remove that confirmation from a normal browser link.

## Requirements

- Node.js with npm
- The ngrok Windows app installed and configured with an ngrok authtoken

The first launch installs the small collaboration-server dependencies in this folder. If needed, install ngrok from [ngrok's Windows guide](https://ngrok.com/download/windows), sign in, then run `ngrok config add-authtoken YOUR_TOKEN` in a terminal. Keep the token private.

## How room sharing works

Yjs syncs edits and presence through a WebSocket server carried by the same HTTPS tunnel, so visitors can join even when direct browser-to-browser connections are blocked. Room updates are saved on this computer in `copad-data`, and each browser also keeps its own IndexedDB copy. Keep this computer and the launcher running for the room to stay online. There is no account system or access control; anyone with a room link can edit it, so only share links with people you trust.
