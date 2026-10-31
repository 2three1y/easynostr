# easynostr

**Nostr, made easy and accessible.** A simple web client for [Nostr](https://nostr.com), built screen reader first, in the spirit of Easy Chirp (the old accessible Twitter web app). Written from scratch.

Live: https://2three1y.github.io/easynostr/

## What it does (v0.1)

- **Home** timeline of people you follow (NIP-02), and a **Global** feed.
- **Read-only mode**: paste any npub to look around.
- **Sign in** with a NIP-07 browser extension, paste an nsec, or make a brand new account. A pasted or new key is kept **only in this browser** (localStorage) and is never sent anywhere. "Log out and forget key" deletes it.
- **Post, reply, repost, like**, delete your own notes, view a **thread**, view a **profile**, **follow / unfollow**, and **notifications** (replies, mentions, likes, reposts).
- **Settings**: theme (match device, dark, light), text size, relays (add, remove, test, reset), keyboard shortcuts on/off, show/hide images, plain-language mode, character count announcements, reduce motion.

## Accessibility, the whole point

- A simple, linear layout. Every note is an `<article>` whose heading is the author's name, so heading navigation in VoiceOver, TalkBack, NVDA or JAWS jumps note to note.
- Real buttons with clear names: "Reply to Jack", "Like, 12 likes" (a toggle button that says if you already liked it).
- Times are words: "5 minutes ago".
- One polite status message area ("Posted to 3 of 4 relays", "Loaded 20 more notes"). Nothing ever refreshes on its own or steals your focus.
- "Load more" button instead of infinite scroll. After loading, focus moves to the first new note.
- Image descriptions come from the note's NIP-92 `imeta` alt text when there is one, otherwise "image, no description".
- Single-key shortcuts (j / k next and previous note, r reply, l like, s repost, o thread, p profile, n new note, ? help) are **off by default** so they never clash with a screen reader. Turn them on in Settings.
- Skip link, one `h1` per page, visible focus, respects reduced motion and Windows high contrast, dark and light themes, scalable text.

## How it is built

Plain HTML, CSS and JavaScript modules. No build step, no frameworks, no CDNs, no trackers, no server of its own. The Nostr protocol code (NIP-01 events and relay connections, NIP-19 bech32 codes) is hand-written in `js/nostr.js`. Signatures use the vendored [noble-secp256k1](https://github.com/paulmillr/noble-secp256k1). See [CREDITS.md](CREDITS.md).

Default relays: relay.damus.io, nos.lol, relay.primal.net, relay.nostr.band. Change them in Settings.

To run it locally, serve the folder with any static server (for example `python3 -m http.server`) and open it. It needs a secure context (https or localhost) for the browser's crypto.

## License

Code: [MIT](LICENSE). Vendored libraries keep their own licenses (see CREDITS.md).

Co-written with Tab.
