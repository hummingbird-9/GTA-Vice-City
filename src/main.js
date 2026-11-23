import {
  LANGUAGES,
  applyTranslations,
  changeLanguage,
  currentLanguage,
  setRawText,
  setText,
  t,
} from "./i18n/index.js";
import {
  GAME_ENTRIES,
  IMPORT_JOURNAL,
  IMPORT_TMP,
  OPFS_VERSION,
  PACKAGE_DATA,
  PACKAGE_INDEX,
  READY_MARKER,
} from "./convert/layout.js";

const BASE = import.meta.env.BASE_URL;

const LEGACY_SCRIPT_SOURCES = [
  `${BASE}controllers.js`,
  `${BASE}GamepadEmulator.js`,
  `${BASE}idbfs.js`,
  `${BASE}shared.js`,
  `${BASE}saves.js`,
  `${BASE}skins.js`,
  `${BASE}game.js`,
];

function isLocalDevEnvironment() {
  return (
    window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

async function clearDevelopmentServiceWorkers() {
  if (!("serviceWorker" in navigator) || !isLocalDevEnvironment()) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${src}"]`);
    if (existingScript) {
      if (existingScript.dataset.loaded === "true") {
        resolve();
        return;
      }

      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error(`Failed to load script: ${src}`)),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load script: ${src}`)),
      { once: true },
    );
    document.body.appendChild(script);
  });
}

async function loadLegacyScripts() {
  for (const src of LEGACY_SCRIPT_SOURCES) {
    await loadScript(src);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

// Verify the repository's committed split package directly from public assets.
// The build workflow independently verifies each committed chunk's exact size.
async function verifyBundledPackage() {
  try {
    const manifestUrl = `${BASE}game-data/vcbr/chunks/manifest.json`;
    const indexUrl = `${BASE}game-data/${PACKAGE_INDEX}`;
    const [manifestResponse, indexResponse] = await Promise.all([
      fetchWithTimeout(manifestUrl, { cache: "no-store" }),
      fetchWithTimeout(indexUrl, { cache: "no-store" }),
    ]);

    if (!manifestResponse.ok) {
      return { ok: false, reason: `Split-data manifest returned ${manifestResponse.status}` };
    }
    if (!indexResponse.ok) {
      return { ok: false, reason: `Game package index returned ${indexResponse.status}` };
    }

    const [manifest, packageIndex] = await Promise.all([
      manifestResponse.json(),
      indexResponse.json(),
    ]);
    const total = manifest.parts?.reduce((sum, part) => sum + part.size, 0);

    if (
      !Array.isArray(manifest.parts) ||
      manifest.parts.length === 0 ||
      total !== manifest.size ||
      packageIndex.remote_package_size !== manifest.size ||
      manifest.size < 100 * 1024 * 1024
    ) {
      return { ok: false, reason: "Split-data manifest and package index do not match" };
    }

    const checks = await Promise.all(manifest.parts.map(async (part) => {
      const url = `${BASE}game-data/vcbr/chunks/${encodeURIComponent(part.name)}`;
      const response = await fetchWithTimeout(url, { method: "HEAD", cache: "no-store" });
      return { name: part.name, ok: response.ok, status: response.status };
    }));
    const failed = checks.find((check) => !check.ok);
    if (failed) {
      return { ok: false, reason: `Game data chunk ${failed.name} returned ${failed.status}` };
    }

    return { ok: true, reason: null, manifest };
  } catch (error) {
    const reason = error.name === "AbortError"
      ? "Timed out while checking bundled game files"
      : `Bundled game check failed: ${error.message}`;
    return { ok: false, reason };
  }
}

// Returns null when either the imported OPFS package or bundled split package is ready.
async function checkReady() {
  // A valid marker identifies a complete imported copy in this browser.
  try {
    const root = await navigator.storage.getDirectory();
    let markerVersion = "";
    try {
      const marker = await (await root.getFileHandle(READY_MARKER)).getFile();
      markerVersion = await marker.text();
    } catch {
      // A bundled package does not need an OPFS marker.
    }

    if (markerVersion === OPFS_VERSION) {
      const getFile = async (path) => {
        const parts = path.split("/");
        let dir = root;
        for (const part of parts.slice(0, -1)) {
          dir = await dir.getDirectoryHandle(part);
        }
        return (await dir.getFileHandle(parts.at(-1))).getFile();
      };

      try {
        const dataFile = await getFile(PACKAGE_DATA);
        const indexFile = await getFile(PACKAGE_INDEX);
        if (dataFile.size >= 100 * 1024 * 1024 && indexFile.size > 0) {
          return null;
        }
      } catch {
        // Incomplete local import: try the committed split package below.
      }
    }
  } catch (error) {
    console.warn("[setup] OPFS is unavailable; trying bundled game data:", error);
  }

  const bundled = await verifyBundledPackage();
  return bundled.ok ? null : bundled.reason;
}

async function verifyGameServing() {
  const requiredUrls = [PACKAGE_DATA, PACKAGE_INDEX].map((path) => `${BASE}${path}`);

  for (const url of requiredUrls) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "HEAD",
        cache: "no-store",
      });
      if (!response.ok) return `Game asset route returned ${response.status}: ${url}`;
    } catch (error) {
      return error.name === "AbortError"
        ? `Timed out checking game asset route: ${url}`
        : `Fetch failed for ${url}: ${error.message}`;
    }
  }

  return null;
}

async function prepareBundledPackageMarker() {
  const bundled = await verifyBundledPackage();
  if (!bundled.ok) {
    console.warn("[setup] bundled game package is not available:", bundled.reason);
    return false;
  }

  // The marker is a convenience for this browser, not a requirement for the
  // repository-bundled read-only package. If OPFS writes are denied, gameplay
  // can still use the verified split files through the service worker.
  try {
    const root = await navigator.storage.getDirectory();
    let needsMarker = false;
    try {
      const marker = await (await root.getFileHandle(READY_MARKER)).getFile();
      needsMarker = (await marker.text()) !== OPFS_VERSION;
    } catch {
      needsMarker = true;
    }

    if (needsMarker) {
      const handle = await root.getFileHandle(READY_MARKER, { create: true });
      const writable = await handle.createWritable();
      await writable.write(OPFS_VERSION);
      await writable.close();
    }
  } catch (error) {
    console.warn("[setup] could not write bundled-package marker; using read-only split files:", error);
  }

  console.log("[setup] verified bundled game-data package");
  return true;
}

async function waitForGameReady(retries = 6, delayMs = 400) {
  let lastReason = "unknown";
  for (let attempt = 0; attempt < retries; attempt++) {
    const opfsReason = await checkReady();
    if (opfsReason !== null) {
      lastReason = opfsReason;
      console.warn(`[waitForGameReady] attempt ${attempt + 1}: ${opfsReason}`);
    } else {
      const servingReason = await verifyGameServing();
      if (servingReason !== null) {
        lastReason = servingReason;
        console.warn(`[waitForGameReady] attempt ${attempt + 1}: ${servingReason}`);
      } else {
        return { ready: true, reason: null };
      }
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }

  return { ready: false, reason: lastReason };
}

async function clearGameFiles() {
  // Clear OPFS: delete all known directories and the marker file
  try {
    const root = await navigator.storage.getDirectory();
    for (const name of [...GAME_ENTRIES, IMPORT_TMP, IMPORT_JOURNAL]) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        // entry may not exist
      }
    }
  } catch (err) {
    console.warn("[reset] OPFS clear failed:", err);
  }
}

const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

// [{ path, file }] for every file in a dropped folder.
async function readDroppedFolder(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    const reader = dir.createReader();
    // Batches until an empty one.
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const entry of batch) {
        const path = `${prefix}/${entry.name}`;
        if (entry.isDirectory) await walk(entry, path);
        else out.push({ path, file: await entryFile(entry) });
      }
    }
  };
  await walk(root, root.name);
  return out;
}

// [{ path, file }] for every file in a folder picked with showDirectoryPicker.
async function readPickedFolder(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const handle of dir.values()) {
      const path = `${prefix}/${handle.name}`;
      if (handle.kind === "directory") await walk(handle, path);
      else out.push({ path, file: await handle.getFile() });
    }
  };
  await walk(root, root.name);
  return out;
}

// Phones can't pick folders; they only get the .zip button.
const canPickFolders = () => !window.matchMedia("(pointer: coarse)").matches;

// Dropping a folder avoids the browser's "upload files?" prompt.
function bindGameDrop(zone, { isBusy, onFile, onFolder, onError }) {
  // Keeps a missed drop from opening the file.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!isBusy()) zone.dataset.dragging = "1";
  });
  zone.addEventListener("dragleave", () => delete zone.dataset.dragging);
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    delete zone.dataset.dragging;
    if (isBusy()) return;
    // Read entries before any await.
    const entry = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .find(Boolean);
    if (!entry) return;
    try {
      if (entry.isFile) onFile(await entryFile(entry));
      else onFolder(entry.name, await readDroppedFolder(entry));
    } catch (err) {
      onError(err);
    }
  });
}

async function initSetupFlow() {
  const overlay = document.getElementById("setup-overlay");
  const zipInput = document.getElementById("game-zip-input");
  const folderInput = document.getElementById("game-folder-input");
  const dropZone = document.getElementById("game-drop");
  const folderBtn = document.getElementById("game-folder-btn");
  const zipBtn = document.getElementById("game-zip-btn");
  const progress = document.getElementById("setup-progress");
  const progressBar = document.getElementById("setup-progress-bar");
  const progressLabel = document.getElementById("setup-progress-label");
  const progressPercent = document.getElementById("setup-progress-percent");
  const errorBox = document.getElementById("setup-error");
  const storageStatus = document.getElementById("storage-status");
  const selectedFileName = document.getElementById("selected-file-name");
  const clickToPlayButton = document.getElementById("click-to-play-button");
  const resetFilesBtn = document.getElementById("reset-files-btn");

  if (
    !overlay ||
    !zipInput ||
    !folderInput ||
    !dropZone ||
    !folderBtn ||
    !zipBtn ||
    !progress ||
    !progressBar ||
    !progressLabel ||
    !progressPercent ||
    !errorBox ||
    !storageStatus ||
    !selectedFileName ||
    !clickToPlayButton
  ) {
    return;
  }


  const showError = (key, options) => {
    errorBox.style.display = "block";
    setText(errorBox, key, options);
  };

  const setStorageStatus = (key, state) => {
    setText(storageStatus, key);
    storageStatus.dataset.state = state;
  };

  const setPlayAvailability = (enabled) => {
    window.__gtaGameReady = enabled;
    clickToPlayButton.disabled = !enabled;
    clickToPlayButton.classList.toggle("disabled", !enabled);
  };

  if (resetFilesBtn) {
    resetFilesBtn.addEventListener("click", async () => {
      if (!confirm(t("setup.resetFilesConfirm"))) {
        return;
      }
      resetFilesBtn.disabled = true;
      setText(resetFilesBtn, "setup.resetting");
      await clearGameFiles();
      setStorageStatus("status.missing", "missing");
      setPlayAvailability(false);
      progress.style.display = "none";
      errorBox.style.display = "none";
      setText(selectedFileName, "setup.drop");
      zipInput.value = "";
      folderInput.value = "";
      resetFilesBtn.disabled = false;
      setText(resetFilesBtn, "setup.resetFiles");
    });
  }

  // No reset or second import while the worker writes.
  let importing = false;
  const setImporting = (value) => {
    importing = value;
    zipInput.disabled = value;
    folderInput.disabled = value;
    folderBtn.disabled = value;
    zipBtn.disabled = value;
    dropZone.classList.toggle("disabled", value);
    if (resetFilesBtn) resetFilesBtn.disabled = value;
  };

  const ERROR_KEYS = {
    notGameFolder: "errors.notGameFolder",
    discImage: "errors.discImage",
    missingFiles: "errors.missingFiles",
    zip: "errors.zip",
    storage: "errors.storage",
  };

  // A worker the browser kills (memory, a frozen tab…) just goes quiet. If
  // it says nothing for this long, a new one resumes where it got to.
  const STALL_MS = 60_000;
  const MAX_RESUMES = 3;

  const runImport = (input, attempt = 0) => {
    if (attempt === 0) {
      errorBox.style.display = "none";
      setImporting(true);
      progress.style.display = "block";
      setText(progressLabel, "progress.checking");
      progressPercent.textContent = "0%";
      progressBar.style.width = "0%";
      setPlayAvailability(false);
      setStorageStatus("status.missing", "missing");
    } else {
      setText(progressLabel, "progress.resuming");
    }

    const worker = new Worker(new URL("./convert/worker.js", import.meta.url), { type: "module" });
    let stallTimer;
    const finish = () => {
      clearTimeout(stallTimer);
      setImporting(false);
      worker.terminate();
    };
    const resume = (reason) => {
      clearTimeout(stallTimer);
      worker.terminate();
      console.warn(`[import] ${reason}, attempt ${attempt + 1}`);
      if (attempt < MAX_RESUMES) {
        runImport(input, attempt + 1);
        return;
      }
      progress.style.display = "none";
      showError("errors.stalled");
      setImporting(false);
    };
    const watch = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => resume("worker stopped responding"), STALL_MS);
    };
    watch();
    worker.onerror = (error) => {
      error.preventDefault?.();
      resume(`worker crashed: ${error.message}`);
    };
    worker.onmessage = async (event) => {
      const message = event.data;
      watch();

      if (message.type === "progress") {
        if (message.phase === "converting") {
          const pct = Math.floor((message.done / message.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressPercent.textContent = `${pct}%`;
          setText(progressLabel, "progress.converting", { done: message.done, total: message.total });
        } else if (message.phase === "unpacking") {
          setText(progressLabel, "progress.unpacking", { file: message.file });
        } else {
          setText(progressLabel, "progress.checking");
        }
        return;
      }

      if (message.type === "warning") {
        console.warn("[import] files differ from the known release:", message.files);
        showError("errors.mismatch", { count: message.files.length });
        return;
      }

      if (message.type === "done") {
        clearTimeout(stallTimer);
        progressBar.style.width = "100%";
        progressPercent.textContent = "100%";
        setText(progressLabel, "progress.verifying");
        const { ready: isReady, reason } = await waitForGameReady();
        setStorageStatus(
          isReady ? "status.ready" : "status.missing",
          isReady ? "ready" : "missing",
        );
        setPlayAvailability(isReady);
        if (isReady) setText(progressLabel, "progress.complete");
        else setText(progressLabel, "progress.verifyFailed", { reason });
        finish();
        return;
      }

      if (message.type === "error") {
        if (message.message) console.error("[import]", message.code, message.message);
        progress.style.display = "none";
        showError(ERROR_KEYS[message.code] || "errors.generic", {
          message: message.message,
          files: (message.files || []).join(", "),
        });
        finish();
      }
    };
    worker.postMessage(input);
  };

  setPlayAvailability(false);

  if (
    !("serviceWorker" in navigator) ||
    !("storage" in navigator && navigator.storage.getDirectory)
  ) {
    setStorageStatus("status.unsupported", "error");
    showError("errors.apis");
    return;
  }

  try {
    if (isLocalDevEnvironment()) {
      console.log("[setup] local dev detected, refreshing SW registration");
      await clearDevelopmentServiceWorkers();
    }

    console.log("[setup] registering SW...");
    await navigator.serviceWorker.register(`${BASE}sw.js`, { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    console.log("[setup] SW ready");

    if (!navigator.serviceWorker.controller) {
      console.log("[setup] SW not yet controlling page — reloading...");
      window.location.reload();
      return;
    }
  } catch (error) {
    setStorageStatus("status.loadFailed", "error");
    showError("errors.serviceWorker", { message: error.message });
    return;
  }

  const startZip = (file) => {
    setRawText(selectedFileName, file.name);
    if (/\.iso$/i.test(file.name)) {
      showError("errors.discImage");
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      showError("errors.notZip");
      return;
    }
    runImport({ kind: "zip", file });
  };

  const startFolder = (name, entries) => {
    setRawText(selectedFileName, name);
    runImport({ kind: "folder", entries });
  };

  zipInput.addEventListener("change", () => {
    const file = zipInput.files[0];
    if (file) startZip(file);
  });

  folderInput.addEventListener("change", () => {
    const files = [...folderInput.files];
    if (!files.length) return;
    const entries = files.map((file) => ({ path: file.webkitRelativePath, file }));
    startFolder(entries[0].path.split("/")[0], entries);
  });

  // Chrome and Edge get the native folder picker (no "upload files?" prompt).
  const pickFolder = async () => {
    if (!window.showDirectoryPicker) return folderInput.click();
    try {
      const dir = await window.showDirectoryPicker({ mode: "read" });
      startFolder(dir.name, await readPickedFolder(dir));
    } catch (err) {
      if (err.name !== "AbortError") showError("errors.generic", { message: err.message });
    }
  };
  folderBtn.addEventListener("click", pickFolder);
  zipBtn.addEventListener("click", () => zipInput.click());
  folderBtn.hidden = !canPickFolders();

  bindGameDrop(dropZone, {
    isBusy: () => importing,
    onFile: startZip,
    onFolder: startFolder,
    onError: (err) => showError("errors.generic", { message: err.message }),
  });

  const hasBundledPackage = await prepareBundledPackageMarker();
  if (hasBundledPackage) {
    selectedFileName.textContent = "Game data installed";
    if (resetFilesBtn) resetFilesBtn.hidden = true;
  }

  const { ready, reason } = await waitForGameReady(2, 150);
  console.log("[setup] game ready:", ready, reason || "");
  if (ready) {
    setStorageStatus("status.ready", "ready");
    setPlayAvailability(true);
    progress.style.display = "none";
    return;
  }

  setStorageStatus("status.missing", "missing");
  errorBox.style.display = "block";
  errorBox.textContent = reason || "The bundled game files could not be verified. Check the site hosting and reload.";

  console.log("[setup] waiting for file selection");
}

function initCanvasBindings() {
  const canvas = document.getElementById("canvas");
  if (!canvas) {
    return;
  }

  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
}

function checkBrowserCompatibility() {
  const missing = [];

  if (!("serviceWorker" in navigator)) missing.push("Service Workers");
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) missing.push("OPFS");
  if (typeof WebAssembly === "undefined") missing.push("WebAssembly");
  if (typeof Worker === "undefined") missing.push("Web Workers");

  return missing;
}

function initOrientationLock() {
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains("gameIsStarted")) {
      observer.disconnect();
      screen.orientation?.lock("landscape").catch(() => {});
    }
  });
  observer.observe(document.body, { attributeFilter: ["class"] });
}

function initLanguagePicker() {
  const select = document.getElementById("ui-lang");
  if (!select) return;

  select.replaceChildren(
    ...LANGUAGES.map(({ code, label }) => new Option(label, code)),
  );
  select.value = currentLanguage();
  select.addEventListener("change", () => {
    void changeLanguage(select.value);
  });
}

async function boot() {
  applyTranslations();
  initLanguagePicker();
  initCanvasBindings();
  initOrientationLock();

  const missing = checkBrowserCompatibility();
  if (missing.length > 0) {
    const storageStatus = document.getElementById("storage-status");
    const errorBox = document.getElementById("setup-error");
    if (storageStatus) {
      setText(storageStatus, "status.unsupported");
      storageStatus.dataset.state = "error";
    }
    if (errorBox) {
      errorBox.style.display = "block";
      setText(errorBox, "errors.missingFeatures", { features: missing.join(", ") });
    }
    return;
  }

  await initSetupFlow();
  try {
    await loadLegacyScripts();
  } catch (err) {
    showScriptLoadError(err);
  }
}

// A script can fail to load right after a deploy, when the browser still has
// the previous page cached but the files it asks for are gone. Say so instead
// of leaving a Start button that does nothing.
function showScriptLoadError(err) {
  console.error("[boot] failed to load a game script:", err);
  const file = String(err && err.message).split("/").pop();

  const startButton = document.getElementById("click-to-play-button");
  if (startButton) {
    startButton.disabled = true;
    startButton.classList.add("disabled");
  }
  const storageStatus = document.getElementById("storage-status");
  if (storageStatus) {
    setText(storageStatus, "status.loadFailed");
    storageStatus.dataset.state = "error";
  }
  const errorBox = document.getElementById("setup-error");
  if (errorBox) {
    errorBox.style.display = "block";
    setText(errorBox, "errors.scriptLoad", { file });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void boot();
  });
} else {
  void boot();
}
