// request-loop の作業前ツリー判定（台帳だけの未コミットで止まらない・LLMを呼ぶ前に止める根拠）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isForbidden, isCollectable, blockingFiles } from "../request-tree.mjs";

test("他ループの台帳（scripts/*-ledger.json）は回収してよい", () => {
  const dirty = ["scripts/agenda-ledger.json", "scripts/minutes-act-ledger.json", "scripts/todo-ledger.json"];
  assert.deepEqual(blockingFiles(dirty), []);
});

test("台帳以外の scripts/・設定ファイルは回収せず止める", () => {
  assert.deepEqual(blockingFiles(["scripts/request-loop.mjs", "index.html"]), ["scripts/request-loop.mjs"]);
  assert.deepEqual(blockingFiles(["firebase.json", "functions/index.js"]), ["firebase.json", "functions/index.js"]);
  assert.equal(isCollectable("scripts/sub/x-ledger.json"), false);
  assert.equal(isCollectable("scripts/x-ledger.json.bak"), false);
});

test("実装後チェックでは台帳も禁止のまま（実装者が台帳を書き換えたら弾く）", () => {
  assert.equal(isForbidden("scripts/todo-ledger.json"), true);
  assert.equal(isForbidden("team.html"), false);
});
