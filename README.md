# Backup & restore of Firefox app data

This tutorial explains how one can create and restore a backup of the full
Android app data, fully offline.

While the Firefox app itself does not support `adb backup` due to
`allowBackups="false"` ([bug 1808763](https://bugzilla.mozilla.org/show_bug.cgi?id=1808763)),
we can still access all data by connecting through a Firefox-specific debugger.

## Requirements

All you need is `adb`, and a desktop Firefox instance to use `about:debugging`:

- Tutorial with screenshots of using `about:debugging`: https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/#debug-your-extension
- Documentation of `about:debugging`: https://firefox-source-docs.mozilla.org/devtools-user/about_colon_debugging/index.html#connecting-to-a-remote-device
- Optional, adb over Wi-Fi (instead of USB): https://firefox-source-docs.mozilla.org/devtools-user/about_colon_debugging/index.html#about-colon-debugging-connecting-to-android-over-wi-fi

To run JavaScript code in Firefox's main process, follow the instructions at
[Running JS snippet in main process](https://github.com/rob--w/android-ext-qa#running-js-snippet-in-main-process).

## Relevant files

The data of Android apps are usually stored in internal storage, private to the
app, inaccessible to other apps and adb. External storage at `/sdcard/` can be
accessed through `adb`, but we need to use a special subdirectory to make sure
that the app can access it without requiring special storage permissions.

Examples of paths for Firefox (app ID `org.mozilla.firefox`):

- Private app data: `/data/user/0/org.mozilla.firefox/`
- Public directory: `/sdcard/Android/data/org.mozilla.firefox/`

The private app data directory contains several directories and files, the most
important ones being:

- `shared_prefs/` - Firefox UI settings and customizations.
- `files/` - Firefox profile directory, with website data (cookies etc).
- `databases/` - Tabs, collections, autofill, logins & passwords, and more.

The following are also relevant for consistency, but not critical:

- `cache/` - Caches, including thumbnails and favicons.
- `nimbus_data/` - Feature flags. Optional, but can change behavior.
- `no_backup/` - Includes `androidx.work` database, e.g. add-on update checks.
- `glean_data/` - Telemetry data (very old profiles may also have `telemetry/`).

## Backup

To create a backup in a readable location, run the following JavaScript snippet
at `about:debugging` and wait for "Done!" to be printed.

```
(async function createBackup() {
  const dirs = ["shared_prefs", "files", "databases", "cache", "nimbus_data", "no_backup", "glean_data"];
  const appid = Services.env.get("MOZ_ANDROID_PACKAGE_NAME");
  const pubdir = "/sdcard/Android/data/" + appid + "/firefox-android-backup/";

  // Remove destination if existent to avoid merging multiple directories.
  await IOUtils.remove(pubdir, { recursive: true });

  // Create parent directory and prevent media scan.
  await IOUtils.getFile(pubdir, ".nomedia");

  const datadir = Services.env.get("GRE_HOME");
  const appfiles = await IOUtils.getChildren(datadir);
  // For informative purposes, in case you want to include more
  console.debug("Found files", appfiles);

  for (let entry of dirs) {
    const from = PathUtils.join(datadir, entry);
    const dest = PathUtils.join(pubdir, entry);
    // Note: copies file attributes, but does not preserve timestamps!
    await IOUtils.copy(from, dest, { recursive: true });
  }
  console.log("Done! Backup files are at: " + pubdir);
})();
```

### Transfer backup to other device

To get the backup on your computer, run the following three commands after each
other. If not using the main Firefox app, replace `org.mozilla.firefox` (2x)
with the actual Android app ID if needed.

```sh
adb shell tar cz -f /sdcard/firefox-android-backup.tar.gz . -C /sdcard/Android/data/org.mozilla.firefox/firefox-android-backup/
adb pull /sdcard/firefox-android-backup.tar.gz

adb shell rm -r /sdcard/Android/data/org.mozilla.firefox/firefox-android-backup/ /sdcard/firefox-android-backup.tar.gz
```

The above puts the backup files in one file `firefox-android-backup.tar.gz`,
pulls the file off the device, and removes these backup files from the device.

## Restore

To restore the backup, we extract the backup file on the Android device first,
to allow the app to move the backup later.

```sh
adb push firefox-android-backup.tar.gz /sdcard/firefox-android-backup.tar.gz
adb shell tar xf /sdcard/firefox-android-backup.tar.gz -C /sdcard/Android/data/org.mozilla.firefox/firefox-android-backup/
adb shell rm /sdcard/firefox-android-backup.tar.gz
```

On the Android device, open the "App Info" of Firefox Android, for example by
long-pressing the app icon and choosing "App Info". Keep this screen open as a
preparation for the next step, with the "Force stop" button visible.

To finally replace the existing files with the backup, run the following
JavaScript snippet at `about:debugging`. When it completes ("Done!" is logged),
click on "Force stop" in the "App Info" view.

```js
(async function restoreBackup() {
  const ignoredAtTop = [".nomedia", "lib"];
  const appid = Services.env.get("MOZ_ANDROID_PACKAGE_NAME");
  const pubdir = "/sdcard/Android/data/" + appid + "/firefox-android-backup/";
  const datadir = Services.env.get("GRE_HOME");

  const nsFile = Components.Constructor("@mozilla.org/file/local;1", "nsIFile", "initWithPath");

  // Use cache dir so that the user can clear it without debugger if needed.
  const tempDir = nsFile(datadir + "/cache/firefox-android-backup.tmp");
  const destDir = nsFile(datadir);

  // Remove destination if existent to avoid merging multiple directories.
  await IOUtils.remove(tempDir.path, { recursive: true });

  // Moving from /sdcard/ to internal /data/ could be an expensive copy+remove.
  await IOUtils.move(pubdir, tempDir.path);
  // Avoid conflicting I/O by the app by using sync nsFile I/O rename/remove.

  // Swap files in tempDir with destDir.
  for (const entry of Array.from(tempDir.directoryEntries)) {
    if (ignoredAtTop.includes(entry.leafName)) {
      continue;
    }
    const dest = destDir.clone();
    dest.append(entry.leafName);
    if (entry.leafName === "cache") {
      // entry is in tempDir, and tempDir is in dest. To swap entry and dest,
      // we need to move dest to a temporary common ancestor (destDir).
      dest.moveTo(destDir, ".old_cache_will_be_moved_again");
      entry.renameTo(destDir, "cache");
      dest.renameTo(tempDir, ".old_cache");
      continue;
    }
    if (dest.exists()) {
      dest.renameTo(tempDir, ".old_" + entry.leafName);
    }
    entry.renameTo(destDir, entry.leafName);
  }

  console.log("Done! Backup restored. Force-stop now to avoid corruption");
  tempDir.remove(true);
})();
```
