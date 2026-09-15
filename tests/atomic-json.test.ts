import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeVerifiedJson } from "../electron/atomic-json";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zhuwen-atomic-test-"));
  created.push(dir);
  return dir;
}

describe("verified atomic JSON writes", () => {
  it("publishes a verified file and removes temporary files", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "book.json");
    await writeVerifiedJson(file, { title: "长夜", chapters: 3 }, (value) => {
      expect(value.title).toBe("长夜");
    });
    expect(JSON.parse(await fs.promises.readFile(file, "utf8"))).toEqual({ title: "长夜", chapters: 3 });
    expect(await fs.promises.readdir(dir)).toEqual(["book.json"]);
  });

  it("does not publish when verification fails", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "invalid.json");
    await expect(writeVerifiedJson(file, { invalid: true }, () => {
      throw new Error("checksum mismatch");
    })).rejects.toThrow("checksum mismatch");
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it("keeps the previous file when verification fails", async () => {
    const dir = await temporaryDirectory();
    const file = path.join(dir, "backup.json");
    await fs.promises.writeFile(file, JSON.stringify({ title: "旧备份" }), "utf8");
    await expect(writeVerifiedJson(file, { title: "坏备份" }, () => {
      throw new Error("checksum mismatch");
    })).rejects.toThrow("checksum mismatch");
    expect(JSON.parse(await fs.promises.readFile(file, "utf8"))).toEqual({ title: "旧备份" });
    expect(await fs.promises.readdir(dir)).toEqual(["backup.json"]);
  });
});
