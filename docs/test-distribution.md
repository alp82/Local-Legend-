# Test distribution runbook

This runbook covers the steps only you can perform to get Local Legend onto your Android phone and iPhone, and to confirm that over-the-air (OTA) updates reach both. It accompanies step 1 of [the implementation plan](../IMPLEMENTATION_PLAN.md).

> **Status (November 15, 2026):** iPhone testers use TestFlight, because ad hoc builds need a registered iPhone and none is available. See [Distribute to iPhone testers with TestFlight](#distribute-to-iphone-testers-with-testflight). The ad hoc iOS sections apply only if you later register your own iPhone. The first Android preview build is `ded52601-f64e-40fe-98ae-94eeb1165ad0`.

Run every command from `mobile/`. The Expo account is `alperortac`, and `eas-cli` is already logged in on this machine. Run the CLI as `npx eas-cli@latest <command>` or through the npm scripts in `mobile/package.json`.

## Key facts

- Bundle identifier and Android package: `com.alperortac.locallegend`.
- Apple team: `QKFZC8CC8J` (Alper Ortac, Individual).
- Build profiles in `eas.json`:
  - `development`: development client, internal distribution, channel `development`.
  - `preview`: standalone build, internal distribution, channel `preview`, Android APK.
  - `testflight`: extends `preview` with store distribution and an auto-incremented build number, for iOS App Store Connect and TestFlight. Channel `preview`, so iPhone testers get the same OTA updates as Android testers.
  - `production`: channel `production`.
- Submit profiles in `eas.json`: `testflight` (Apple team and bundle identifier set; the App Store Connect app ID is resolved at submit time) and `production`.
- The runtime version policy is `fingerprint`. JavaScript and asset changes ship OTA. Changes to native dependencies, config plugins, or permissions change the fingerprint and need a new build.
- The home screen shows the `BUILD_MARKER` constant, the `expo-updates` update ID, channel, runtime version, whether the running bundle is embedded or OTA, and a **Check for update** button.

## Before you begin

1. Confirm you have a paid Apple Developer Program membership. TestFlight and ad hoc distribution both need it. Ad hoc distribution to a physical iPhone uses ad hoc provisioning, which requires a paid account and allows at most 100 iPhones per membership year.
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

## Distribute to iPhone testers with TestFlight

iPhone testers install the app through Apple's TestFlight app. You don't need an iPhone yourself. The `testflight` build profile creates a store-signed build on channel `preview`, and the `testflight` submit profile uploads it to App Store Connect.

### What already exists

As of November 15, 2026:

- The bundle identifier `com.alperortac.locallegend` is registered on the Apple team.
- An Apple Distribution Certificate (serial `181C73E6…`, valid until October 23, 2027) is stored on EAS and already used by `@alperortac/yepwatch`. Reuse it. An individual team can hold only a few distribution certificates.
- An App Store Connect API key, `[Expo] EAS Submit AfFzEAni45` (key ID `64U9XA7NZK`, role App Manager), is stored on the Expo account. EAS Submit can reuse it to upload builds.
- Local Legend has no iOS credentials on EAS yet, no iOS builds, and no App Store Connect link on EAS. EAS creates the App Store provisioning profile during the first build.
- Whether an App Store Connect app record exists can't be checked without signing in to Apple. If none exists, `eas submit` creates one, as described in the following steps.
- `app.json` sets `ITSAppUsesNonExemptEncryption` to `false`, so the build doesn't ask about encryption, and App Store Connect doesn't ask for export compliance on each build.

### Why channel `preview`

Updates are published per platform and per runtime version, and the runtime version comes from each platform's own fingerprint. Putting the TestFlight build on the `preview` channel means one channel and one set of commands serve both platforms, and Android builds aren't affected. The trade-off: every OTA update you publish to `preview` for iOS reaches TestFlight testers immediately, without Beta App Review. That's acceptable while all testers are friends testing the same build. Before a public App Store release, use the `production` profile and channel instead.

### Build and submit

Run these from `mobile/` in an interactive terminal. If you'd rather review the app record first, create it before you start: in [App Store Connect](https://appstoreconnect.apple.com/apps), click **+ > New App**, choose **iOS**, enter the name, choose language **English (U.S.)**, choose bundle ID `com.alperortac.locallegend`, enter any unique SKU, such as `locallegend`, and choose **Full Access**.

1. Start the build with automatic submission:

   ```sh
   npx eas-cli@latest build --profile testflight --platform ios --auto-submit
   ```

2. Answer the prompts:

   | Prompt | Answer |
   | --- | --- |
   | **Do you want to log in to your Apple account?** | **Yes** |
   | **Apple ID** | Your Apple ID email |
   | Password and two-factor code | Your password, then the code. Without an Apple device, choose the SMS option to get the code. |
   | **Reuse this distribution certificate?** (shows the certificate used by `@alperortac/yepwatch`) | **Yes** |
   | **Generate a new Apple Provisioning Profile?** | **Yes** |
   | **Would you like to set up Push Notifications for your app?** (if asked) | **No**. The app doesn't use remote push notifications yet. |
   | **iOS app only uses standard/exempt encryption?** (only if `ITSAppUsesNonExemptEncryption` is missing from `app.json`) | **Yes** |
   | **Reuse this App Store Connect API Key?** (shows `[Expo] EAS Submit AfFzEAni45`) | **Yes** |

   If the CLI warns about uncommitted changes, they're included in the build. Commit first if you want the build to match a commit.

3. Wait for the build. It takes about 15 to 30 minutes. The submission starts automatically when the build finishes.
4. If no App Store Connect app record exists, the submission creates one named **Local Legend**. If that name is taken, the CLI adds a random suffix, such as `Local Legend (a1b2c3)`. You can rename the app later in App Store Connect. It also creates an internal TestFlight group called **Team (Expo)** and adds the team's admins.
5. Wait for Apple to process the build. This takes 5 to 30 minutes, and Apple emails you when it's done.

If you built without `--auto-submit`, submit the latest build later:

```sh
npx eas-cli@latest submit --profile testflight --platform ios --latest
```

For later builds, run step 1 again. The prompts are shorter, because EAS stores the credentials. Each build gets the next build number.

### Choose internal or external testing

| | Internal testing | External testing |
| --- | --- | --- |
| Who | Up to 100 people who are App Store Connect users on your team | Up to 10,000 people with any email address, or a public link |
| Review | None. Builds are available right after processing. | Beta App Review for the first build of each version. Usually under a day. |
| Required information | None | Beta App Description, feedback email, contact name, phone and email for the reviewer, and sign-in details if the app needs an account |
| Build lifetime | 90 days | 90 days |

Use internal testing for a few close friends. Use external testing when you don't want to give testers access to your App Store Connect account, or when you need a public link.

A privacy policy URL is required for external testing. TestFlight asks for it on the **Test Information** page. Because the app records location, write an honest policy and host it at a public URL before you add external testers.

Beta App Review checks location use. Make the Beta App Description explain the background location recording, and match the permission prompts in `app.json`.

### Invite internal testers

1. In [Users and Access](https://appstoreconnect.apple.com/access/users), click **+**, enter the tester's name and email, choose the **Customer Support** or **Marketing** role (the least access that works), and allow access to the Local Legend app.
2. The tester accepts the App Store Connect invitation email.
3. In App Store Connect, open **Apps > Local Legend > TestFlight**. Under **Internal Testing**, select **Team (Expo)** (or create a group), click **+** next to **Testers**, and add the tester.
4. The tester gets a TestFlight email, installs **TestFlight** from the App Store, and taps **View in TestFlight**, or enters the redeem code.

### Invite external testers

1. In **TestFlight > Test Information**, fill in the **Beta App Description**, **Feedback Email**, **Privacy Policy URL**, and **Beta App Review Information** (your contact details). Sign-in information isn't needed because the app has no accounts.
2. Under **External Testing**, click **+**, and create a group, such as `Friends`.
3. In the group, add the build, answer **What to Test**, and click **Submit for Review**.
4. After approval, add testers by email under **Testers**, or turn on **Public Link** and share the link.
5. Testers install **TestFlight** from the App Store and open the email or the link on their iPhone.

Later builds of the same version usually skip review. A new version, such as `1.1.0`, needs review again.

### Ship OTA updates to iPhone testers

Merged changes under `mobile/` publish themselves to the `preview` channel for both platforms ([deploy.md](deploy.md), "App updates"). The pipeline publishes only for runtimes listed in `.github/app-runtimes.json`, so after the first TestFlight build reaches testers:

1. Get the build's runtime version from `npx eas-cli build:list --platform ios` in `mobile/`.
2. Put it in the `ios` list of `.github/app-runtimes.json` (it holds a placeholder until then) and merge that in a pull request.

If the iOS fingerprint changes, for example after you add a native package, create and submit a new TestFlight build and add its runtime the same way.

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
   npm run update:preview -- "Change build marker" --platform ios
   ```

   Run the `ios` command once an iOS build exists. Pass `--platform android` or `--platform ios` because the web export fails on `expo-sqlite`. Pass it on the command line, not in the script: the runtime fingerprint includes the `scripts` section of `mobile/package.json`, so editing any script changes the runtime version and installed builds stop receiving updates.

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
