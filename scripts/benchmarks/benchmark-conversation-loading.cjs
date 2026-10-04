const { app, BrowserWindow, ipcMain } = require("electron");
const { resolve } = require("node:path");
const { mkdirSync, writeFileSync } = require("node:fs");
const { performance } = require("node:perf_hooks");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const rendererDir = resolve(argument("--renderer-dir", resolve(__dirname, "../../dist")));
const outputDir = resolve(argument("--output-dir", "."));
const label = argument("--label", "fixture");
const pageSize = Number(argument("--page-size", "6000"));
const messageCount = Number(argument("--messages", "6000"));
const auxiliaryCount = Number(argument("--auxiliaries", "20"));
const switchCount = Number(argument("--switches", String(auxiliaryCount * 2)));
const counters = {};
const transfers = [];
const bookmarks = new Set();
const incarnations = new Map();
const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
function messages(id, start = Math.max(0, messageCount - pageSize)) {
  return Array.from({ length: Math.min(pageSize, messageCount - start) }, (_, offset) => {
    const index = start + offset;
    const prefix = `${id} message ${index} `;
    return { role: index % 2 ? "assistant" : "user", text: prefix + "x".repeat(Math.max(0, 1024 - prefix.length)), historyIndex: index, isBookmarked: bookmarks.has(`${id}:${index}`) };
  });
}
ipcMain.handle("benchmark:conversation", (_event, name, args, template) => {
  let response = template;
  if (name === "getSession" || name === "getAuxiliarySession") {
    const incarnationId = name === "getAuxiliarySession" ? template?.createdAt : "benchmark-incarnation";
    if (template) incarnations.set(template.id, incarnationId);
    response = template ? { ...template, messages: messages(template.id), messageCount, incarnationId, ...(name === "getAuxiliarySession" ? { preview: template.id } : {}) } : null;
  } else if (name === "getConversationPage") {
    const startIndex = args[1]?.startIndex ?? Math.max(0, messageCount - pageSize);
    response = { sessionId: args[0], incarnationId: incarnations.get(args[0]) ?? "benchmark-incarnation", messages: messages(args[0], startIndex), startIndex, totalCount: messageCount };
  } else if (name === "listConversationNavigator") {
    response = Array.from({ length: messageCount }, (_, index) => ({ messageIndex: index, role: index % 2 ? "assistant" : "user", preview: `${args[0]} message ${index}`, accent: false, isBookmarked: bookmarks.has(`${args[0]}:${index}`) }));
  } else if (name === "listAuxiliarySessions") {
    response = template.map(item => ({ ...item, preview: item.id, messageCount }));
  } else if (name === "searchConversation") {
    response = Array.from({ length: messageCount }, (_, index) => index).filter(index => `${args[0]} message ${index} ${"x".repeat(1024)}`.includes(args[1].query)).map(messageIndex => ({ messageIndex, occurrenceIndex: 0 }));
  } else if (name === "setSessionMessageBookmark" || name === "setAuxiliaryMessageBookmark") {
    const value = args[0];
    const key = `${value.sessionId ?? value.auxiliarySessionId}:${value.messageIndex}`;
    if (value.isBookmarked) bookmarks.add(key); else bookmarks.delete(key);
    response = undefined;
  }
  counters[name] = (counters[name] ?? 0) + 1;
  transfers.push({ name, requestJsonUtf8Bytes: bytes(args), responseJsonUtf8Bytes: bytes(response), messageCount: response?.messages?.length ?? 0, startIndex: response?.startIndex, bodyUtf8Bytes: response?.messages?.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) ?? 0 });
  return response;
});

async function settled(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const textarea = document.querySelector('textarea[data-shortcut-scope="composer"]');
      if (textarea && !textarea.disabled) return requestAnimationFrame(() => requestAnimationFrame(resolve));
      if (performance.now() - started > 30000) return reject(new Error("Composer not ready"));
      requestAnimationFrame(poll);
    }; poll();
  })`);
}
async function memory(window) {
  return {
    main: process.memoryUsage(),
    renderer: await window.webContents.executeJavaScript("({ heap: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null })"),
    processes: app.getAppMetrics().map(({ type, pid, memory }) => ({ type, pid, memory })),
  };
}
async function auxiliarySettled(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const pane = document.querySelector('#session-auxiliary-chat-pane');
      const id = document.querySelector('.concurrent-chat-session-switcher .session-switcher-label')?.textContent?.match(/benchmark-aux-\\d+/)?.[0];
      if (id && pane?.textContent?.includes(id + " message " + ${messageCount - 1})) return requestAnimationFrame(() => requestAnimationFrame(resolve));
      if (performance.now() - started > 30000) return reject(new Error("Auxiliary body not ready: " + id + " label=" + document.querySelector('.concurrent-chat-session-switcher')?.textContent + " body=" + pane?.textContent?.slice(-1600)));
      requestAnimationFrame(poll);
    }; requestAnimationFrame(poll);
  })`);
}
async function bodyVisible(window, paneSelector, text) {
  return window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const started=performance.now();
    const poll=()=>{
      const pane=document.querySelector(${JSON.stringify(paneSelector)});
      const list=pane?.querySelector('.session-message-list');
      const target=[...pane?.querySelectorAll('.rich-text')??[]].find(item=>item.textContent.includes(${JSON.stringify(text)}));
      const rect=target?.getBoundingClientRect(), viewport=list?.getBoundingClientRect();
      if(rect && viewport && rect.top < viewport.bottom && rect.bottom > viewport.top && rect.left < viewport.right && rect.right > viewport.left) return requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({rect:{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right},viewport:{top:viewport.top,bottom:viewport.bottom,left:viewport.left,right:viewport.right}})));
      if(performance.now()-started>15000)return reject(new Error('Body not visible: '+${JSON.stringify(text)}));
      requestAnimationFrame(poll);
    };poll();
  })`);
}
async function verifyUi(window) {
  const observations = [];
  await window.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('#session-main-chat-pane');
    const button = [...pane.querySelectorAll('button')].find(item=>item.textContent.trim()==='Earlier Messages');
    if (!button) throw new Error('Earlier Messages unavailable'); button.click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  observations.push({ operation: "earlier", page: transfers.filter(item => item.name === "getConversationPage").at(-1) });
  writeFileSync(resolve(outputDir, `${label}-earlier.png`), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('#session-main-chat-pane');
    const bookmark = pane.querySelector('button[aria-label="Add bookmark"]');
    if (!bookmark) throw new Error('Bookmark unavailable'); bookmark.click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  observations.push({ operation: "bookmark", calls: counters.setSessionMessageBookmark ?? 0, markedButtonRendered: await window.webContents.executeJavaScript("Boolean(document.querySelector('#session-main-chat-pane button[aria-label=\"Remove bookmark\"]'))") });
  await window.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('#session-main-chat-pane');
    const button = [...pane.querySelectorAll('button')].find(item=>item.textContent.trim()==='Later Messages');
    if (!button) throw new Error('Later Messages unavailable'); button.click();
  })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  observations.push({ operation: "later", page: transfers.filter(item => item.name === "getConversationPage").at(-1) });
  for (const operation of ["Earlier Messages", "Later Messages"]) {
    await window.webContents.executeJavaScript(`(() => {
      const pane=document.querySelector('#session-auxiliary-chat-pane');
      const button=[...pane.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(operation)});
      if(!button)throw new Error('Auxiliary page button unavailable');button.click();
    })()`);
    await new Promise(resolve=>setTimeout(resolve,300));
    observations.push({ operation: `auxiliary-${operation}`, page: transfers.filter(item=>item.name==='getConversationPage').at(-1), errors: await window.webContents.executeJavaScript("[...document.querySelectorAll('#session-auxiliary-chat-pane [role=alert]')].map(item=>item.textContent)") });
  }
  writeFileSync(resolve(outputDir, `${label}-auxiliary-later.png`), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Collapse Auxiliary\"]')?.click()");
  await new Promise(resolve => setTimeout(resolve, 100));
  await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Open Auxiliary\"]')?.click()");
  await auxiliarySettled(window);
  observations.push({ operation: "auxiliary-close-reopen", ready: true });
  writeFileSync(resolve(outputDir, `${label}-reopened.png`), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='Main')?.click();
    document.querySelector('#session-main-chat-pane')?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
  })()`);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: ["control"] });
  await new Promise(resolve => setTimeout(resolve, 100));
  const findOpened = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('input[aria-label="Find in current content"]');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'benchmark-main message 0 ');
    input.dispatchEvent(new Event('input',{bubbles:true})); return true;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 700));
  observations.push({ operation: "search-outside-tail", findOpened, calls: counters.searchConversation ?? 0, page: transfers.filter(item => item.name === "getConversationPage").at(-1), oldMessageMounted: await window.webContents.executeJavaScript("document.querySelector('#session-main-chat-pane')?.textContent?.includes('benchmark-main message 0 ')") });
  observations.push({ operation: "search-visible-body", ...(await bodyVisible(window, '#session-main-chat-pane', 'benchmark-main message 0 ').catch(error=>({error:String(error)}))) });
  observations.push({ operation: "search-hit-range", ...(await window.webContents.executeJavaScript(`(() => {
    const pane=document.querySelector('#session-main-chat-pane');
    const list=pane?.querySelector('.session-message-list');
    const walker=document.createTreeWalker(pane,NodeFilter.SHOW_TEXT);
    let node;
    while(node=walker.nextNode()){
      const offset=node.textContent.indexOf('benchmark-main message 0 ');
      if(offset<0 || !node.parentElement.closest('.rich-text'))continue;
      const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+'benchmark-main message 0 '.length);
      const rect=range.getBoundingClientRect(),viewport=list.getBoundingClientRect();
      return { rect:{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right},viewport:{top:viewport.top,bottom:viewport.bottom,left:viewport.left,right:viewport.right},visible:rect.top>=viewport.top && rect.bottom<=viewport.bottom && rect.left>=viewport.left && rect.right<=viewport.right };
    }
    return {visible:false,error:'Search text range not mounted'};
  })()`)) });
  writeFileSync(resolve(outputDir, `${label}-search.png`), (await window.webContents.capturePage()).toPNG());
  return observations;
}
async function main() {
  mkdirSync(outputDir, { recursive: true });
  app.setPath("userData", resolve(outputDir, `${label}-isolated-user-data`));
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: resolve(__dirname, "benchmark-composer-input-preload.cjs"), contextIsolation: true, sandbox: false,
    partition: `benchmark-${label}-${Date.now()}`,
    backgroundThrottling: false, additionalArguments: ["--benchmark-conversation-loading", `--benchmark-auxiliary-count=${auxiliaryCount}`],
  } });
  window.webContents.on("render-process-gone", (_event, detail) => console.error(detail));
  window.webContents.on("console-message", (_event, _level, message) => console.error(message));
  console.log("window created");
  const beforeLoad = { main: process.memoryUsage(), processes: app.getAppMetrics() };
  console.log("before-load memory recorded");
  const started = performance.now();
  await window.loadFile(resolve(rendererDir, "session.html"), { search: "?sessionId=benchmark-main" });
  console.log("renderer loaded");
  await settled(window);
  const initialReadyMs = performance.now() - started;
  const initialBodyRect = await bodyVisible(window, '#session-main-chat-pane', `benchmark-main message ${messageCount - 1} `);
  const initialBodyReadyMs = performance.now() - started;
  const initialTransfers = transfers.slice();
  const initialMemory = await memory(window);
  writeFileSync(resolve(outputDir, `${label}-main.png`), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === "Auxiliary");
    if (!button) throw new Error("Auxiliary button missing"); button.click();
    document.querySelector('[aria-label="Open Auxiliary"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  await auxiliarySettled(window);
  console.log("first auxiliary ready");
  const auxiliaryReadyMs = performance.now() - started - initialReadyMs;
  writeFileSync(resolve(outputDir, `${label}-auxiliary.png`), (await window.webContents.capturePage()).toPNG());
  const afterFirstAuxiliary = await memory(window);
  const switchSamples = [];
  const transferCountBeforeSwitches = transfers.length;
  for (let index = 0; index < switchCount; index++) {
    const switchStarted = performance.now();
    await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[aria-label="Auxiliary conversation"] button[aria-label="Next"]');
      if (!button || button.disabled) throw new Error("Auxiliary Next button unavailable"); button.click();
    })()`);
    await auxiliarySettled(window);
    switchSamples.push(performance.now() - switchStarted);
    console.log(`switch ${index + 1} ready`);
  }
  const afterSwitches = await memory(window);
  const switchTransfers = transfers.slice(transferCountBeforeSwitches);
  const uiObservations = process.argv.includes("--verify-ui") ? await verifyUi(window).catch(error => [{ error: String(error) }]) : undefined;
  const result = { label, measurement: "synthetic main-process API fixture, real Electron IPC and renderer; bytes are JSON UTF-8 payload estimates, not Electron wire framing; first ready is navigation to composer enabled plus two rAF, not GPU paint; auxiliary ready is Main ready to last fixture body mounted plus two rAF, including intervening memory and screenshot checkpoints; process memory is unforced-GC working set/heap and contains Chromium overhead, Electron process memory fields are KiB; no SQLite worker runs in this stage", rendererDir, versions: process.versions, conditions: { messageCount, bodyBytes: 1024, auxiliaryCount, pageSize, viewport: [1280, 900], switches: auxiliaryCount * 2 }, initialReadyMs, auxiliaryReadyMs, initialTransfers, transfers, counters, beforeLoad, initialMemory, afterFirstAuxiliary, afterSwitches, switchSamples, switchTransfers };
  writeFileSync(resolve(outputDir, `${label}.json`), JSON.stringify({ ...result, conditions: { ...result.conditions, switches: switchCount }, initialBodyReadyMs, initialBodyRect, uiObservations }, null, 2));
  console.log(JSON.stringify({ label, initialReadyMs, auxiliaryReadyMs, counters }));
  window.destroy();
  app.quit();
}
main().catch(error => { console.error(error); app.exit(1); });
