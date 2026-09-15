import { describe, expect, it } from "vitest";
import { relevantMaterials } from "./relevant";

const item = (over: Record<string, unknown>) => ({
  id: "id1",
  kind: "character",
  title: "林川",
  content_json: JSON.stringify({ body: "主角，性格沉稳" }),
  ...over,
});

describe("relevantMaterials", () => {
  it("按标题命中正文并统计出现次数", () => {
    const out = relevantMaterials(
      [item({})],
      "林川走进码头。林川没有回头。",
    );
    expect(out).toHaveLength(1);
    expect(out[0].matched).toBe("林川");
    expect(out[0].count).toBe(2);
    expect(out[0].content).toContain("性格沉稳");
  });

  it("人物关系按两端姓名匹配，内容为关系摘要", () => {
    const out = relevantMaterials(
      [
        item({
          id: "r1",
          kind: "relation",
          title: "师徒",
          from: "苏晚",
          to: "陈舟",
          content_json: JSON.stringify({ label: "师徒", body: "旧识" }),
        }),
      ],
      "苏晚看了一眼陈舟，陈舟装作没看见。",
    );
    expect(out[0].title).toBe("苏晚 与 陈舟");
    expect(out[0].count).toBe(2);
    expect(out[0].content).toContain("师徒");
  });

  it("人物卡别名也可命中正文", () => {
    const out = relevantMaterials(
      [
        item({
          id: "a1",
          title: "苏晚",
          content_json: JSON.stringify({ body: "女主", alias: "晚晚,苏姑娘" }),
        }),
      ],
      "晚晚低头不语。",
    );
    expect(out[0].matched).toBe("晚晚");
    expect(out[0].count).toBe(1);
  });

  it("忽略单字与未出现的资料", () => {
    const out = relevantMaterials(
      [
        item({ id: "a", title: "雨" }),
        item({ id: "b", title: "雾港灯塔" }),
      ],
      "雨下了一夜。",
    );
    expect(out).toHaveLength(0);
  });

  it("按出现次数排序并截取上限", () => {
    const items = [1, 2, 3, 4].map((i) =>
      item({ id: `c${i}`, title: `人物${i}` }),
    );
    const corpus = "人物1 人物1 人物1 人物2 人物2 人物4";
    const out = relevantMaterials(items, corpus, 2);
    expect(out.map((x) => x.title)).toEqual(["人物1", "人物2"]);
  });

  it("正文为空时不产生推荐", () => {
    expect(relevantMaterials([item({})], "")).toHaveLength(0);
  });
});
