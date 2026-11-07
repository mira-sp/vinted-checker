const input = document.getElementById("server");
const status = document.getElementById("status");
const DEFAULT_SERVER = "http://127.0.0.1:3000";

chrome.storage.sync.get({ server: DEFAULT_SERVER }).then(({ server }) => {
  input.value = server;
});

input.addEventListener("change", async () => {
  const value = input.value.trim() || DEFAULT_SERVER;
  try {
    const url = new URL(value);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error();
  } catch {
    status.textContent = "Use an address like http://127.0.0.1:3000 (the app only runs on this computer).";
    return;
  }
  await chrome.storage.sync.set({ server: value });
  status.textContent = "Saved.";
});
