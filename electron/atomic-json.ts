import fs from "node:fs";
import { randomUUID } from "node:crypto";

export async function writeVerifiedJson(
  file: string,
  value: unknown,
  verify: (restored: any) => void,
) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(temporary, "wx");
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const restored = JSON.parse(await fs.promises.readFile(temporary, "utf8"));
    verify(restored);
    await fs.promises.rename(temporary, file);
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Cleanup below remains best effort.
      }
    }
    try {
      await fs.promises.unlink(temporary);
    } catch {
      // The rename may already have completed.
    }
    throw error;
  }
}
