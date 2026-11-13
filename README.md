# LAST LAUGH 🎤

A phone-controlled party game for 3–10 players, plus unlimited audience voters.

## Setup (one time)
Install Node.js from https://nodejs.org, then in this folder run:

    npm install

## Playing at a party
1. Connect your laptop to the TV with HDMI.
2. Run `npm start` in this folder.
3. On the laptop, open **http://localhost:3000/host** and make it fullscreen. Click once so the narrator and sound turn on.
4. Everyone scans the QR code with their phone camera. **Phones must be on the same Wi-Fi as the laptop.**
5. The first person to join is the 👑 VIP and can start the game from their phone.

## How it plays
- **Rounds 1 & 2:** each player gets 2 prompts, and each prompt is shared with one other player. Everyone else votes on the two answers. Round 2 is worth double points. If everyone votes for one answer, that's a SWEEP bonus.
- **Final round (The Last Laugh):** everyone answers the same prompt, then everyone votes for their favorite.
- People who join after the game starts (or once there are 10 players) become the audience and can still vote.
- 🛟 **Safety** fills in a random answer if you've got nothing.

## Customize
- Add your own prompts and inside jokes in `prompts.js`.
- Change the timers at the top of `server.js` (the `T` object).

## Troubleshooting
- **Phones can't connect:** make sure they're on the same Wi-Fi, not cellular. Some guest or school networks block devices from talking to each other; a phone hotspot works as a fallback. You may also need to allow Node through your firewall (Windows will ask).
- **Wrong IP in the QR code:** run `PUBLIC_URL=http://YOUR-IP:3000 npm start`.
- **Someone's phone locked or refreshed:** just reopen the page. They rejoin automatically.
- **Game stuck waiting on someone:** hover the bottom-right corner of the TV and click ⏭ Skip timer.
