// Renders build/icon.svg to PNGs with an offscreen Electron window and packs
// build/icon.ico (PNG entries) + build/icon.png. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = path.join(__dirname, "..");
  const svgPath = path.join(root, "build", "icon.svg");
  const win = new BrowserWindow({
    show: false,
    frame: false,
    useContentSize: true,
    width: 512,
    height: 512,
  });
  const pngs = new Map();
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    const htmlPath = path.join(os.tmpdir(), `zhuwen-icon.html`);
    fs.writeFileSync(
      htmlPath,
      `<html><body style="margin:0;overflow:hidden">
        <img style="display:block" width="${size}" height="${size}" src="file:///${svgPath.replace(/\\/g, "/")}">
      </body></html>`,
      "utf8",
    );
    win.setContentSize(size, size);
    await win.loadURL("file:///" + htmlPath.replace(/\\/g, "/"));
    await wait(300);
    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: size,
      height: size,
    });
    pngs.set(
      size,
      image.resize({ width: size, height: size, kernel: "lanczos" }).toPNG(),
    );
    console.log("rendered", size, image.getSize());
  }
  fs.writeFileSync(path.join(root, "build", "icon.png"), pngs.get(512));
  const ico = makeIco(
    [16, 32, 48, 64, 128, 256].map((s) => ({ size: s, buf: pngs.get(s) })),
  );
  fs.writeFileSync(path.join(root, "build", "icon.ico"), ico);
  win.destroy();
  console.log("ICONS_OK", ico.length, "bytes");
}

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = [];
  let cur = 6 + entries.length * 16;
  for (const e of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
    entry.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(e.buf.length, 8);
    entry.writeUInt32LE(cur, 12);
    dir.push(entry);
    cur += e.buf.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.buf)]);
}

app.whenReady().then(async () => {
  try {
    await main();
    console.log("done");
    app.exit(0);
  } catch (e) {
    console.error("ICON_FAIL", e);
    app.exit(1);
  }
});
