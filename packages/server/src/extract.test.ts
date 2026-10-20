import { test } from "vitest";
import assert from "node:assert";
import { parseExtraction } from "./extract.ts";

test("extract: 解析严格 JSON 数组", () => {
  const items = parseExtraction(`[{"content":"用户偏好中文","confidence":0.9,"reason":"多次要求"}]`);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, "用户偏好中文");
});

test("extract: 忽略模型输出的前后闲聊", () => {
  const items = parseExtraction(`好的,提取结果如下:\n[{"content":"a"}]\n以上。`);
  assert.equal(items.length, 1);
});

test("extract: 无 JSON 或非法内容返回空", () => {
  assert.deepEqual(parseExtraction("没有值得记的内容"), []);
  assert.deepEqual(parseExtraction(`[{"nope":1}]`), []);
  assert.deepEqual(parseExtraction("[broken"), []);
});
