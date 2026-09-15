// One-off mechanical split of src/App.tsx into ui/* modules.
// Blocks are contiguous line ranges from the original file; headers are prepended.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = "src/App.tsx";
const lines = readFileSync(SRC, "utf8").split("\n");
const at = (a, b) => lines.slice(a - 1, b).join("\n"); // 1-indexed inclusive

// Inject export keywords into a block.
const exp = (block, names) => {
  let out = block;
  for (const n of names) {
    out = out.replace(
      new RegExp(`^(function ${n}\\()`, "m"),
      `export function ${n}(`,
    );
    out = out.replace(
      new RegExp(`^(const ${n} =)`, "m"),
      `export const ${n} =`,
    );
    out = out.replace(
      new RegExp(`^(type ${n} =)`, "m"),
      `export type ${n} =`,
    );
    out = out.replace(
      new RegExp(`^(function ${n}<)`, "m"),
      `export function ${n}<`,
    );
  }
  return out;
};

mkdirSync("src/ui", { recursive: true });

// shared.tsx ------------------------------------------------------------
const shared = [
  `import { useCallback, useEffect, useMemo, useState } from "react";`,
  `import { marked } from "marked";`,
  `import sanitizeHtml from "sanitize-html";`,
  ``,
  exp(at(10, 77), [
    "AnyRow", "Result", "api", "useAiSessionStore", "emptyDoc", "fmt",
    "time", "UiLanguage", "UI", "tx",
  ]),
  ``,
  exp(at(2596, 2611), ["MdView"]),
  ``,
  exp(at(2772, 2820), ["DiffModal"]),
  ``,
  exp(at(2822, 2851), ["kinds", "readerFonts", "kindNames"]),
  ``,
  exp(at(2853, 2891), ["DiffLine", "diffLines"]),
  ``,
  exp(at(3335, 3348), ["parseJson", "parseTags"]),
  ``,
  exp(at(4481, 4503), ["Modal"]),
  ``,
  exp(at(4505, 4522), ["Empty"]),
  ``,
].join("\n");
writeFileSync("src/ui/shared.tsx", shared + "\n");

// shelf.tsx -------------------------------------------------------------
writeFileSync(
  "src/ui/shelf.tsx",
  [
    `import { useEffect, useState } from "react";`,
    `import { api, time, Empty, Modal, AnyRow } from "./shared";`,
    ``,
    exp(at(270, 345), ["CreateNovel"]),
    ``,
    exp(at(444, 507), ["NovelTrash"]),
    ``,
  ].join("\n"),
);

// novel-edit.tsx ----------------------------------------------------------
writeFileSync(
  "src/ui/novel-edit.tsx",
  [
    `import { useState } from "react";`,
    `import { api, Modal, AnyRow } from "./shared";`,
    ``,
    exp(at(347, 442), ["NovelEdit"]),
    ``,
  ].join("\n"),
);

// ai-panel.tsx ------------------------------------------------------------
writeFileSync(
  "src/ui/ai-panel.tsx",
  [
    `import { useCallback, useEffect, useMemo, useRef, useState } from "react";`,
    `import { joinSegments, splitSegments } from "../segments";`,
    `import { relevantMaterials } from "../relevant";`,
    `import { api, useAiSessionStore, fmt, kindNames, Empty, Modal, DiffModal, MdView, AnyRow } from "./shared";`,
    ``,
    exp(at(1907, 2594), ["AiPanel"]),
    ``,
    exp(at(2613, 2680), ["SegmentsModal"]),
    ``,
  ].join("\n"),
);

// summary-modal.tsx ---------------------------------------------------------
writeFileSync(
  "src/ui/summary-modal.tsx",
  [
    `import { useEffect, useState } from "react";`,
    `import { api, time, Modal, AnyRow } from "./shared";`,
    ``,
    exp(at(2682, 2770), ["SummaryModal"]),
    ``,
  ].join("\n"),
);

// library-panel.tsx ---------------------------------------------------------
writeFileSync(
  "src/ui/library-panel.tsx",
  [
    `import { useCallback, useEffect, useMemo, useState } from "react";`,
    `import { characterPresence } from "../relevant";`,
    `import { api, fmt, time, parseJson, parseTags, Empty, kinds, AnyRow } from "./shared";`,
    ``,
    exp(at(2893, 3282), ["LibraryPanel"]),
    ``,
    exp(at(3284, 3333), ["RelationGraph"]),
    ``,
  ].join("\n"),
);

// history-panel.tsx -----------------------------------------------------------
writeFileSync(
  "src/ui/history-panel.tsx",
  [
    `import { useEffect, useState } from "react";`,
    `import { api, fmt, time, Empty, DiffModal, AnyRow } from "./shared";`,
    ``,
    exp(at(3350, 3456), ["HistoryPanel"]),
    ``,
    exp(at(3458, 3464), ["sourceName"]),
    ``,
  ].join("\n"),
);

// trash-panel.tsx -----------------------------------------------------------
writeFileSync(
  "src/ui/trash-panel.tsx",
  [
    `import { useEffect, useState } from "react";`,
    `import { api, time, Empty, AnyRow } from "./shared";`,
    ``,
    exp(at(3466, 3540), ["TrashPanel"]),
    ``,
  ].join("\n"),
);

// settings.tsx --------------------------------------------------------------
writeFileSync(
  "src/ui/settings.tsx",
  [
    `import { useEffect, useState } from "react";`,
    `import { api, readerFonts, AnyRow, UiLanguage } from "./shared";`,
    ``,
    exp(at(3542, 4059), ["Settings"]),
    ``,
    exp(at(4061, 4186), ["AppearanceSettings"]),
    ``,
  ].join("\n"),
);

// io-panel.tsx ---------------------------------------------------------------
writeFileSync(
  "src/ui/io-panel.tsx",
  [
    `import { useEffect, useState } from "react";`,
    `import { api, time, AnyRow } from "./shared";`,
    ``,
    exp(at(4188, 4479), ["IoPanel"]),
    ``,
  ].join("\n"),
);

// workspace.tsx ---------------------------------------------------------------
writeFileSync(
  "src/ui/workspace.tsx",
  [
    `import { useCallback, useEffect, useMemo, useRef, useState } from "react";`,
    `import { useEditor, EditorContent } from "@tiptap/react";`,
    `import StarterKit from "@tiptap/starter-kit";`,
    `import Placeholder from "@tiptap/extension-placeholder";`,
    `import { api, fmt, time, tx, UiLanguage, Empty, Modal, AnyRow } from "./shared";`,
    `import { NovelEdit } from "./novel-edit";`,
    `import { AiPanel } from "./ai-panel";`,
    `import { LibraryPanel } from "./library-panel";`,
    `import { HistoryPanel } from "./history-panel";`,
    `import { TrashPanel } from "./trash-panel";`,
    `import { Settings } from "./settings";`,
    `import { IoPanel } from "./io-panel";`,
    `import { SummaryModal } from "./summary-modal";`,
    ``,
    exp(at(509, 1789), ["Workspace"]),
    ``,
    exp(at(1791, 1905), ["Section"]),
    ``,
    `export default Workspace;`,
  ].join("\n"),
);

// App.tsx (new) ----------------------------------------------------------------
writeFileSync(
  SRC,
  [
    `import { useCallback, useEffect, useState } from "react";`,
    `import { api, useAiSessionStore, Empty, AnyRow } from "./ui/shared";`,
    `import { CreateNovel, NovelTrash } from "./ui/shelf";`,
    `import { NovelEdit } from "./ui/novel-edit";`,
    `import Workspace from "./ui/workspace";`,
    ``,
    at(79, 268),
    ``,
    at(4524, 4550),
  ].join("\n"),
);

console.log("split done");
