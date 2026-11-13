# Ledger

Private personal finance for India, inspired by [Sure](https://github.com/we-promise/sure). Runs entirely in the browser; data is encrypted on the device.

## Deploy (GitHub Pages)
1. Create a repo, e.g. `ledger`, and upload everything in this folder (keep the folder structure).
2. Settings → Pages → Deploy from branch → `main` / root.
3. On iPhone, open `https://<username>.github.io/ledger/` in Safari → Share → **Add to Home Screen**. Always open it from the Home Screen icon.

## Updating
Upload the changed files, and bump `VERSION` in `sw.js` so phones fetch the new version. Your data is not affected by updates.

## Where data lives
- IndexedDB database `ledger-app-vault` on the device, AES-256-GCM encrypted.
- Unlock key wrapped by Face ID (WebAuthn passkey with the PRF extension, iOS 18+) and by your recovery passphrase (PBKDF2, 600k iterations).
- Backups (More → Back up) are encrypted files; restoring needs the recovery passphrase.
- Deleting the Home Screen app deletes its data. Keep backups.

## Files
- `index.html` markup and styles · `js/app.js` UI · `js/store.js` encryption and storage · `js/parsers.js` statement parsers · `js/rules.js` Indian categories and merchant rules · `vendor/` pdf.js (Apache-2.0) for reading PDFs on-device.
