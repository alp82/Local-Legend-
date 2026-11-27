# Test distribution runbook

This runbook covers the steps only you can perform to get Local Legend onto your Android phone and iPhone, and to confirm that over-the-air (OTA) updates reach both. It accompanies step 1 of [the implementation plan](../IMPLEMENTATION_PLAN.md).

> **Status (November 14, 2026):** iOS testing is deferred because no physical iPhone is available. The iOS sections apply once one is. The first Android preview build is `ded52601-f64e-40fe-98ae-94eeb1165ad0`.

Run every command from `mobile/`. The Expo account is `alperortac`, and `eas-cli` is already logged in on this machine. Run the CLI as `npx eas-cli@latest <command>` or through the npm scripts in `mobile/package.json`.

## Key facts

- Bundle identifier and Android package: `com.alperortac.locallegend`.
- Build profiles in `eas.json`:
  - `development`: development client, internal distribution, channel `development`.
  - `preview`: standalone build, internal distribution, channel `preview`, Android APK.
  - `production`: channel `production`.
- The runtime version policy is `fingerprint`. JavaScript and asset changes ship OTA. Changes to native dependencies, config plugins, or permissions change the fingerprint and need a new build.
- The home screen shows the `BUILD_MARKER` constant, the `expo-updates` update ID, channel, runtime version, whether the running bundle is embedded or OTA, and a **Check for update** button.

## Before you begin

1. Confirm you have a paid Apple Developer Program membership. Internal distribution to a physical iPhone uses ad hoc provisioning, which requires a paid account and allows at most 100 iPhones per membership year.
2. If your membership is new or recently renewed, expect a 24 to 72 hour delay before a newly registered device can be added to a provisioning profile. If the first iOS build fails right after you register a device, wait and retry.
3. On Android, be ready to allow your browser or file manager to install unknown apps (**Settings > Apps > Special app access > Install unknown apps**; the exact path varies by manufacturer).

## Register your iPhone

1. Run `npx eas-cli@latest device:create` and choose the website option. The CLI prints a URL and QR code.
2. Open the URL on the iPhone in Safari and install the provisioning profile it offers. This sends the device UDID to Expo.
3. Run `npx eas-cli@latest device:list` and confirm the iPhone appears. Optionally run `npx eas-cli@latest device:rename` to give it a friendly name.

Only iOS builds created after a device is registered install on that device. When you add a device later, register it, then either rebuild or re-sign an existing build:

```sh
npx eas-cli@latest build:resign --platform ios --target-profile preview
```

Run iOS builds interactively and sign in with your Apple account when prompted, so EAS can update the ad hoc provisioning profile with the new device.

## Build and install preview builds

Preview builds are standalone. They don't need a development server, so they're what you use to test OTA updates.

1. Start both builds:

   ```sh
   npm run build:preview:android
   npm run build:preview:ios
   ```

2. When each build finishes, open its page on expo.dev (the CLI prints the link), click **Install**, and send the install link to the phone. You can also scan the QR code on the phone.
3. On Android, download the APK, allow the install when prompted, and open the app.
4. On iPhone, open the link in Safari, install the app, then enable Developer Mode (iOS 16 and later):
   1. Open the app. When iOS shows an alert about Developer Mode, tap **OK**.
   2. Go to **Settings > Privacy & Security > Developer Mode** and turn on the toggle.
   3. Tap **Restart**.
   4. After the restart, unlock the phone, tap **Turn On**, and enter your passcode.

   You only do this once per device.
5. On both phones, check that the home screen shows channel `preview`, a runtime version, and an embedded (not OTA) launch.

## Use development builds day to day

Development builds load JavaScript from your computer, so you see changes instantly without publishing updates.

1. Build and install the development client the same way as the preview builds:

   ```sh
   npm run build:dev:android
   npm run build:dev:ios
   ```

2. Run `npm start` on your computer.
3. Open the Local Legend development build on the phone and connect to the server it lists, or scan the QR code in the terminal. Your phone and computer must be on the same network.

In development builds, `Updates.channel` and `Updates.updateId` are `null`, and **Check for update** doesn't work. Use the preview builds for OTA checks.

## Verify OTA updates

Merged changes under `mobile/` publish themselves to the `preview` channel ([deploy.md](deploy.md), "App
updates"), when the testers' builds can run them. Publish by hand only to test something before merging.

1. Note the current `BUILD_MARKER` and update ID on both phones.
2. Change `BUILD_MARKER` in `mobile/` to a new value.
3. Publish the update to the `preview` channel:

   ```sh
   npm run update:preview -- "Change build marker" --platform android
   ```

   Pass `--platform android` (or `ios`) because the web export fails on `expo-sqlite`. Pass it on the command line, not in the script: the runtime fingerprint includes the `scripts` section of `mobile/package.json`, so editing any script changes the runtime version and installed builds stop receiving updates.

4. On each phone, either tap **Check for update**, or force-close and reopen the app. By default, the app downloads an update in the background at launch and applies it on the next cold start, so you might need to force-close and reopen it twice.
5. Confirm on both phones:
   - `BUILD_MARKER` shows the new value.
   - The update ID changed and matches the update on expo.dev.
   - The launch shows OTA, not embedded.
   - The runtime version is unchanged.

## Decide between OTA and a new build

Publish OTA when you change only JavaScript, TypeScript, or assets. Create new builds for both platforms when you:

- Add, remove, or upgrade a package that contains native code.
- Add or change a config plugin or anything in `app.json` that affects native projects.
- Add or change permissions, such as location or background modes.
- Upgrade the Expo SDK or React Native.

To check, compare the local fingerprint with the installed build:

```sh
npx eas-cli@latest fingerprint:compare --build-id <build-id> --environment preview
```

Run `npx eas-cli@latest fingerprint:compare` with no arguments to pick builds interactively, or `npx eas-cli@latest fingerprint:generate --platform ios --environment preview` to print the current fingerprint. If the fingerprint differs, an update published now targets a runtime version that no installed build has, so the phones won't receive it until you rebuild.

## Troubleshoot

**The update doesn't appear.**

- Confirm the build and the update use the same channel (`preview`) on the home screen and on expo.dev.
- Confirm the update's runtime version matches the one shown on the home screen. A mismatch means the fingerprint changed and you need a new build.
- Force-close and reopen the app twice. The first launch downloads the update, and the next cold start applies it.
- Confirm you're testing a preview build, not a development build.

**The iPhone won't install or open the app.**

- If the install fails, confirm the iPhone was registered before the build was created. If not, rebuild or re-sign.
- If the app won't open, turn on Developer Mode as described earlier.
- An "Untrusted Developer" prompt applies to enterprise-signed builds, not ad hoc ones. If you see it, go to **Settings > General > VPN & Device Management** and trust the developer.

**Android blocks the APK.** Google Play Protect may warn about an app from an unknown developer. Tap **More details > Install anyway**. If the install is blocked entirely, check that the source app is allowed to install unknown apps.
