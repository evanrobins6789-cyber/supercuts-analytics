# iPhone app: setup guide

The iPhone app is a native shell (Capacitor, in `ios/`) that opens
https://supercuts-analytics.vercel.app. Website changes show up in the app
right away. You only rebuild the app for native changes (name, icon, plugins).

- App name: **Supercuts Dashboard** (App Store listing; `capacitor.config.json` → `appName`). Home-screen label: **SC Dashboard** (`CFBundleDisplayName` in `ios/App/App/Info.plist`)
- Bundle ID: **com.robinsdashboard.app** (can't be changed after the first upload to Apple)
- Push notifications: `src/push.js` (phone side + Setup → iPhone App), `api/_push.js` (sends via Apple)

## 1. Apple Developer account ($99/year)
1. Enroll at https://developer.apple.com/programs. Organization = your company name shows as the seller (needs a free D-U-N-S number); Individual = your own name.
2. **Identifiers** → + → App IDs → App → Bundle ID (Explicit) `com.robinsdashboard.app` → tick **Push Notifications** → Register.
3. **Keys** → + → name "Push" → tick **Apple Push Notifications service (APNs)** → Register → **Download** the `.p8` file (you can download it only once). Note the **Key ID** and your **Team ID** (Membership page).

## 2. Turn on sending (Vercel)
On **both** Vercel projects → Settings → Environment Variables:
- `APNS_KEY_ID` = Key ID
- `APNS_TEAM_ID` = Team ID
- `APNS_PRIVATE_KEY` = the whole .p8 file contents (open in Notepad, include the BEGIN/END lines)
- `APNS_BUNDLE_ID` = `com.robinsdashboard.app`

Redeploy.

## 3. Create the app in App Store Connect
https://appstoreconnect.apple.com → Apps → + → New App: platform iOS, name, language, bundle ID `com.robinsdashboard.app`, SKU (anything, e.g. `dashboard1`), access Full.

## 4. Codemagic (builds the app from GitHub on its Macs)
1. Sign up at https://codemagic.io with GitHub and give it access to the `supercuts-analytics` repo.
2. App Store Connect → Users and Access → Integrations → **App Store Connect API** → + → name "Codemagic", access **App Manager** → download the `.p8` key, note the Issuer ID and Key ID.
3. Codemagic → Team settings → Integrations → **Developer Portal** → Connect → name it exactly **App Store Key**, paste Issuer ID, Key ID, upload that `.p8`.
4. Codemagic → Add application → the repo → it finds `codemagic.yaml`.
5. **Signing files (once)**: the `ios_signing` block only uses certificates/profiles already saved in Codemagic; it does not create them (first build failed with "No matching profiles found", 2026-11-23).
   - Codemagic → Settings → codemagic.yaml settings → Code signing identities → **iOS certificates** → Generate certificate (key "App Store Key", type Apple Distribution). Save the .p12 and password it shows.
   - developer.apple.com → Profiles → + → **App Store Connect** (Distribution) → App ID `com.robinsdashboard.app` → that certificate → name it → Generate.
   - Back in Codemagic → **iOS provisioning profiles** → Fetch profiles → select it → Download selected.
6. **Start new build** → workflow "iPhone app -> App Store Connect". About 15–20 min. Builds, signs and uploads to App Store Connect.

## 5. Listing + review
In App Store Connect, on the app's version page:
- Screenshots (6.9" and 6.5" iPhone; take them on a phone, or ask Claude to make them), description, keywords, support URL.
- **Privacy policy URL** (required).
- App Privacy questions: name, phone number (for login), and device ID (for notifications), all linked to the user and none used for tracking.
- **Sign-in info for the reviewer**: Apple must be able to log in. Make a test login with a PIN (Setup → Employee Access) and give the PIN in "App Review Information".
- Pick the build Codemagic uploaded → Add for Review → Submit.

## 6. Unlisted distribution
Request it at https://developer.apple.com/contact/request/unlisted-app (needs the app's Apple ID from App Store Connect → App Information). After approval, the App Store link only works for people who have it; send that link to staff.

## Updating the app later
Only needed for native changes (icon, name, plugin updates). Bump `MARKETING_VERSION` in `ios/App/App.xcodeproj/project.pbxproj` if it's a new version, run a Codemagic build, and submit the new build for review.

## Known review risks
- **Guideline 4.2 (minimum functionality)**: a website in an app shell can be rejected. Push notifications are the native feature that addresses this.
- **Guideline 5.1.1(v) (account deletion)**: apps that let people create an account must let them delete it in the app. The site has phone sign-up, so Apple may ask for a "Delete my login" option.
- **Guideline 5.2 (trademarks)**: don't use the Supercuts name in the listing without corporate's written OK. The icon has "SUPERCUTS" on the scissors.
