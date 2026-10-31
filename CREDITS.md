# Credits

## Vendored code

- **noble-secp256k1** v3.2.0 by Paul Miller, MIT License. File: `js/vendor/noble-secp256k1.js`, license: `js/vendor/noble-secp256k1.LICENSE.txt`. Source: https://github.com/paulmillr/noble-secp256k1. Used for BIP-340 Schnorr signatures (signing and verifying Nostr events). Hashing uses the browser's built-in Web Crypto.

That is the only third-party code. Everything else (Nostr protocol helpers, bech32/NIP-19, relay pool, interface) was written from scratch for easynostr.

## Inspiration

- **Easy Chirp** by Dennis Lembree, the accessible Twitter web app. easynostr borrows the *idea* (simple, linear, screen reader first), not any code.
- The Nostr protocol and its NIPs: https://github.com/nostr-protocol/nips

## Made by

2three1y, co-written with Tab.
