// Source: https://github.com/Rob--W/firefox-android-backup-restore
var HELP_USAGE_TEXT = `Usage:
https://github.com/Rob--W/firefox-android-backup-restore

1. Verify that this program works (optional):
fab_sanity_check();

2. Create backup first. Example: store on computer.
$ adb reverse tcp:12101 tcp:12101
$ nc -l -s 127.0.0.1 -p 12101 > firefox-android-backup.tar.gz
fab_backup_create();

(disconnect device, connect other device)

3. Restore backup once you have a succesful backup.
$ adb shell mkdir /sdcard/Android/data/org.mozilla.firefox/
$ adb push firefox-android-backup.tar.gz /sdcard/Android/data/org.mozilla.firefox/
fab_backup_restore();
(app will be force-stopped to avoid data corruption; logs available at)
$ adb shell cat /sdcard/Android/data/org.mozilla.firefox/firefox-android-backup.log

4. Clean up any temporary files created by us on the device.
fab_cleanup();
`;
console.log(HELP_USAGE_TEXT);

var FAB_PORT = 12101; // Port used to exchange backup data.
fab_sanity_check();

function fab_sanity_check() {
  if (typeof ChromeUtils === "undefined") {
    console.warn("Bad debugging session! To fix this:");
    console.warn("1. Open about:blank on the phone.");
    console.warn("2. Close the current debugger.");
    console.warn("2. Visit about:debugging, inspect the Main Process again.");
  }
  let result = system_exec("exit 123");
  if (result !== 123) {
    console.debug("fab_sanity_check(): expected 123, got " + result);
    throw new Error("fab_sanity_check(): Unable to execute code on the device!");
  }
  return true;
}

function fab_backup_create() {
  const APP_HOME = android_path_private_appdata();
  const SHELL_CODE = String.raw`
set -e -o pipefail
echo "Streaming firefox-android-backup.tar.gz to 127.0.0.1:${FAB_PORT}"
echo "The listener should have been set up with:"
echo '$ adb reverse tcp:12101 tcp:12101'
echo '$ nc -l -s 127.0.0.1 -p 12101 > firefox-android-backup.tar.gz'

set -x
tar cz -C '${APP_HOME}' \
  shared_prefs files databases cache nimbus_data no_backup glean_data \
  | nc 127.0.0.1 ${FAB_PORT}

echo "DONE: fab_backup_create() finished."
`;
  system_exec_check_output(SHELL_CODE);
  console.log("Backup successfully created and transferred!");
}

function fab_backup_restore() {
  const APP_HOME = android_path_private_appdata();
  const SHARED_HOME = android_path_public_appdata();

  // Put everything in cache/, so that the user can manually clear cache via App Info if wanted.
  const BACKUP_TMP = APP_HOME + "/cache/firefox-android-backup.tmp";
  const TRASH_TMP = APP_HOME + "/cache/firefox-android-trash.tmp";
  // Need another tmp dir: Cannot move "cache" in APP_HOME to TRASH_TMP due to circular dependency. 
  const CACHE_TRASH_TMP = APP_HOME + "/firefox-android-cache-trash.tmp";
  const SHELL_CODE = String.raw`
set -ex
rm -rf '${BACKUP_TMP}' '${TRASH_TMP}' '${CACHE_TRASH_TMP}'
mkdir -p '${BACKUP_TMP}' '${TRASH_TMP}'
echo "Retrieving backup from ${SHARED_HOME}/firefox-android-backup.tar.gz"
tar xz -C '${BACKUP_TMP}' -f '${SHARED_HOME}/firefox-android-backup.tar.gz'
cd '${BACKUP_TMP}'
for entry in * ; do
  [ "$entry" != lib ] || continue
  [ "$entry" != .nomedia ] || continue
  [ "$entry" != cache ] || continue
  mv '${APP_HOME}/'"$entry" '${TRASH_TMP}/'
  mv '${BACKUP_TMP}'/"$entry" '${APP_HOME}'
done
if [ -d '${BACKUP_TMP}/cache' ] ; then
  mv '${TRASH_TMP}' '${CACHE_TRASH_TMP}'
  mv '${APP_HOME}/cache' '${CACHE_TRASH_TMP}/'
  mv '${CACHE_TRASH_TMP}/cache/firefox-android-backup.tmp/cache' '${APP_HOME}/cache'
  mv '${CACHE_TRASH_TMP}' '${TRASH_TMP}'
fi
rm -rf '${TRASH_TMP}'

echo "DONE: fab_backup_restore() finished."
`;
  system_exec_check_output(SHELL_CODE);
  system_exec_nofork("exit 0");
  // ^ should exit; force-stops app to avoid data corruption in the app dir.
}

function fab_cleanup() {
  const SHARED_HOME = android_path_public_appdata();
  // Note: these are async.
  IOUtils.remove(SHARED_HOME + "/firefox-android-backup.log");
  IOUtils.remove(SHARED_HOME + "/firefox-android-backup.tar.gz");
}


/**
 * system_exec - Execute a command (in a shell) and returns the exit code. The
 * current process is blocked until the command exits.
 *
 * system_exec_check_output - Execute a command (in a shell) and prints the output.
 * Throws if the program execution failed.
 *
 * system_exec_nofork - Replaces the current process with the command.
 *
 * Test case: see exit code

   system_exec("exit 123"); // result: 123

 * Test case: list files of app dir

   system_exec_check_output("ls -la $GRE_HOME");

 * Test case: execute command, sent to local server on Android:

   adb shell nc -l -p 12345
   system_exec("echo Hello from $HOME | nc 127.0.0.1 12345");

 * To receive on the host, use this instead of "adb shell nc ...":

   adb reverse tcp:12345 tcp:12345
   nc -l -p 12345
 */
function system_exec(command, _internal_caller) {
  command = command.trim();
  const skip_fork = _internal_caller === system_exec_nofork;
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );
  const libc = ctypes.open("libc.so");
  const fork = libc.declare(
    "fork",
    ctypes.default_abi,
    ctypes.int // pid (parent), 0 (child), or -1 (error)
  );
  const exit = libc.declare(
    "exit",
    ctypes.default_abi,
    ctypes.void_t, // [[noreturn]]
    ctypes.int // exit code
  );
  const execv = libc.declare(
    "execl",
    ctypes.default_abi,
    ctypes.int, // 0 (ok) or -1 (error)
    ctypes.char.ptr, // path
    ctypes.char.ptr, // arg0
    ctypes.char.ptr, // arg1
    ctypes.char.ptr, // arg2
    ctypes.char.ptr // NULL arg
  );
  const WEXITSTATUS = wstatus => (wstatus >> 8) & 0xFF;
  const waitpid = libc.declare(
    "waitpid",
    ctypes.default_abi,
    ctypes.int32_t, // pid (same as input) or -1 (error)
    ctypes.int32_t, // pid
    ctypes.int.ptr, // status
    ctypes.int // options
  );
  let rv = 0;
  try {
    if (!skip_fork) {
      rv = fork();
      if (rv === -1) {
        throw new Error("fork() failed, errno=" + ctypes.errno);
      }
    }
    if (rv === 0) {
      rv = execv("/bin/sh", "sh", "-c", command, ctypes.char.ptr(0));
      // execv only returns if an error has occurred.
      console.error("execv failed: " + rv + ", errno=" + ctypes.errno);
      if (!skip_fork) {
        rv = exit(ctypes.errno);
        throw new Error("exit() unexpectedly returned!!!");
      }
    } else {
      const status = ctypes.int();
      rv = waitpid(rv, status.address(), 0);
      if (rv === -1) {
        throw new Error("waitpid failed, errno=" + ctypes.errno);
      }
      rv = WEXITSTATUS(status.value);
    }
    return rv;
  } finally {
    libc.close();
  }
}

// See system_exec for documentation.
function system_exec_check_output(command) {
  const SHARED_HOME = android_path_public_appdata();
  const PUBLIC_LOG_FILE = SHARED_HOME + "/firefox-android-backup.log";

  const SHELL_CODE = `
mkdir -p '${SHARED_HOME}'
exec 2>'${PUBLIC_LOG_FILE}' 1>&2

${command}`;
  let rv = system_exec(SHELL_CODE);
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PUBLIC_LOG_FILE);
    const output = Cu.readUTF8File(file);
    console.log(output);
  } catch (e) {
    console.warn("Failed to read output", e);
  }
  if (rv !== 0) {
    throw new Error("Process exited non-successfully, exit code " + rv);
  }
  return rv;
}

// See system_exec for documentation.
function system_exec_nofork(command) {
  return system_exec(command, system_exec_nofork);
}

function android_path_private_appdata() {
  // E.g. "/data/user/0/org.mozilla.firefox"
  return safe_path(Services.env.get("GRE_HOME"));
}

function android_path_public_appdata() {
  const appid = Services.env.get("MOZ_ANDROID_PACKAGE_NAME");
  let dir = "/sdcard/Android/data/" + appid;
  return safe_path(dir);
}

function safe_path(path) {
  // Allow all printable ASCII, excluding characters that have
  // a special meaning even when quoted with " or '.
  if (!/^\/((?![!"$'\\`])[ -~])+$/.test(path)) {
    throw new Error("Rejected unsafe path: " + path);
  }
  return path;
}
