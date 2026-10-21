import { describe, expect, it } from "vitest";
import { gitQuoteBody, gitUnquote, normalizePath, parseUnifiedDiff, pickDiff } from "./gitDiff";

const MODIFIED = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@ export function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;",
  "",
].join("\n");

const ADDED = [
  "diff --git a/docs/新文件.md b/docs/新文件.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  '+++ "b/docs/\\346\\226\\260\\346\\226\\207\\344\\273\\266.md"',
  "@@ -0,0 +1,2 @@",
  "+# 标题",
  "+正文",
  "",
].join("\n");

const RENAMED = [
  "diff --git a/old.txt b/new.txt",
  "similarity index 100%",
  "rename from old.txt",
  "rename to new.txt",
  "",
].join("\n");

const DELETED_BINARY = [
  "diff --git a/logo.png b/logo.png",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "Binary files a/logo.png and /dev/null differ",
  "",
].join("\n");

describe("git 路径转义", () => {
  it("八进制转义与 git core.quotePath 互逆", () => {
    const quoted = gitQuoteBody("docs/新文件.md");
    expect(quoted).toBe("docs/\\346\\226\\260\\346\\226\\207\\344\\273\\266.md");
    expect(gitUnquote(`"${quoted}"`)).toBe("docs/新文件.md");
    expect(gitUnquote("plain/path.ts")).toBe("plain/path.ts");
  });

  it("工作区绝对路径归一为相对路径", () => {
    expect(normalizePath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(normalizePath("src\\a.ts", "")).toBe("src/a.ts");
  });
});

describe("parseUnifiedDiff", () => {
  it("解析修改文件的行号与增删统计", () => {
    const [f] = parseUnifiedDiff(MODIFIED);
    expect(f.path).toBe("src/app.ts");
    expect(f.status).toBe("M");
    expect(f.adds).toBe(2);
    expect(f.dels).toBe(1);
    const kinds = f.lines.map((l) => l.kind);
    expect(kinds).toEqual(["hunk", "ctx", "del", "add", "add", "ctx"]);
    const del = f.lines[2];
    expect(del.oldNo).toBe(2);
    expect(del.newNo).toBeUndefined();
    const lastCtx = f.lines[5];
    expect(lastCtx.oldNo).toBe(3);
    expect(lastCtx.newNo).toBe(4);
  });

  it("识别新增、重命名、删除与二进制文件", () => {
    const files = parseUnifiedDiff(MODIFIED + ADDED + RENAMED + DELETED_BINARY);
    expect(files.map((f) => f.status)).toEqual(["M", "A", "R", "D"]);
    expect(files[1].path).toBe("docs/新文件.md");
    expect(files[1].adds).toBe(2);
    expect(files[2].path).toBe("new.txt");
    expect(files[2].oldPath).toBe("old.txt");
    expect(files[3].path).toBe("logo.png");
    expect(files[3].binary).toBe(true);
  });

  it("空输入返回空数组", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("pickDiff", () => {
  const all = MODIFIED + ADDED;

  it("按路径选出对应文件段(含转义的中文路径)", () => {
    expect(pickDiff(all, "src/app.ts").segment).toBe(MODIFIED);
    expect(pickDiff(all, "docs/新文件.md").segment).toBe(ADDED);
  });

  it("路径是目录时提示目录回退", () => {
    const r = pickDiff(all, "src");
    expect(r.segment).toBe("");
    expect(r.dirFallback).toBe(true);
  });

  it("无匹配时返回空段", () => {
    expect(pickDiff(all, "missing.ts")).toEqual({ segment: "", dirFallback: false });
  });
});
