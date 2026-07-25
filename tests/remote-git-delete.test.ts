import { describe, expect, it } from "vitest";
import { isMissingRemoteBranchError } from "../src/adapters/remote-git.js";

describe("isMissingRemoteBranchError", () => {
  it("matches English missing remote ref messages", () => {
    expect(
      isMissingRemoteBranchError(
        "error: unable to delete 'matt-auto/255/ticket-256/r1': remote ref does not exist\n",
      ),
    ).toBe(true);
  });

  it("matches Traditional Chinese missing remote ref messages", () => {
    expect(
      isMissingRemoteBranchError(
        "error: 無法刪除 'matt-auto/255/ticket-256/r1'：遠端引用不存在\nerror: 推送一些引用到 'https://github.com/a5345534/aos.git' 失敗\n",
      ),
    ).toBe(true);
  });

  it("matches Simplified Chinese missing remote ref messages", () => {
    expect(
      isMissingRemoteBranchError(
        "error: 无法删除 'matt-auto/1/ticket-2/r1'：远程引用不存在\n",
      ),
    ).toBe(true);
  });

  it("does not treat unrelated push failures as missing", () => {
    expect(
      isMissingRemoteBranchError(
        "error: failed to push some refs to 'https://github.com/a5345534/aos.git'\n! [rejected] matt-auto/255/integration -> matt-auto/255/integration (fetch first)\n",
      ),
    ).toBe(false);
  });
});
