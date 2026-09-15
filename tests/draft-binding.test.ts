import { describe, expect, it } from "vitest";

/** 与主进程 applyDraftPatch 同源规则：目标会话必须匹配，版本不得回退 */
export function shouldAcceptDraftPatch(args: {
  patchNovelId: string;
  patchConvId: string;
  patchVersion?: number;
  currentNovelId: string;
  currentConvId: string;
  storedVersion?: number;
}) {
  if (args.patchConvId !== args.currentConvId) return false;
  if (args.patchNovelId && args.patchNovelId !== args.currentNovelId)
    return false;
  if (
    args.patchVersion != null &&
    args.storedVersion != null &&
    args.patchVersion < args.storedVersion
  )
    return false;
  return true;
}

describe("draft patch binding", () => {
  it("rejects delayed patch after switching conversation", () => {
    expect(
      shouldAcceptDraftPatch({
        patchNovelId: "n1",
        patchConvId: "A",
        patchVersion: 5,
        currentNovelId: "n1",
        currentConvId: "B",
        storedVersion: 1,
      }),
    ).toBe(false);
  });

  it("rejects older version overwriting newer draft", () => {
    expect(
      shouldAcceptDraftPatch({
        patchNovelId: "n1",
        patchConvId: "A",
        patchVersion: 2,
        currentNovelId: "n1",
        currentConvId: "A",
        storedVersion: 5,
      }),
    ).toBe(false);
  });

  it("accepts matching conversation with newer or equal version", () => {
    expect(
      shouldAcceptDraftPatch({
        patchNovelId: "n1",
        patchConvId: "A",
        patchVersion: 6,
        currentNovelId: "n1",
        currentConvId: "A",
        storedVersion: 5,
      }),
    ).toBe(true);
  });
});
