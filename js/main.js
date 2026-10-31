// easynostr entry point.
import { applySettings, route, updateNav } from './app.js';

applySettings();
window.addEventListener('hashchange', () => route());
route();
// Some extensions add window.nostr a moment after the page loads.
setTimeout(updateNav, 1500);
