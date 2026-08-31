import assert from "node:assert/strict";
import test from "node:test";

const { buildNotificationSettingsResponse, qqNotificationSchema } = await import("./routes");

const agent = {
  enabled: false,
  requireConfirmation: true,
  maxResults: 6,
  permissions: {
    readMail: true,
    manageReadState: true,
    manageNotifications: true,
    runProcessing: true,
    checkMailboxes: true,
    reclassifyMail: true
  }
};

test("QQ notification settings accept a blank write-only secret and validate AppID", () => {
  const parsed = qqNotificationSchema.parse({
    appId: "1900000000",
    appSecret: "",
    enabled: true,
    quoteImageMarksRead: true,
    notifyCategories: { important: true, secondary: true, ignore: false },
    agent: { enabled: true, permissions: { runProcessing: false } }
  });
  assert.equal(parsed.appSecret, "");
  assert.equal(parsed.agent?.enabled, true);
  assert.equal(parsed.agent?.permissions?.runProcessing, false);
  assert.throws(() => qqNotificationSchema.parse({ ...parsed, appId: "not-an-app-id" }));
});

test("combined notification settings never serialize QQ secrets or full recipient IDs", () => {
  const openId = "abcdefgh12345678";
  const response = buildNotificationSettingsResponse(
    {
      enabled: true,
      clawbotApiUrl: "http://127.0.0.1:18011/api/send",
      clawbotRecipientId: "wechat-user",
      importantOnly: false,
      notifyCategories: { important: true, secondary: true, ignore: false }
    },
    {
      appId: "1900000000",
      enabled: true,
      hasAppSecret: true,
      maskedAppSecret: "test...cret",
      quoteImageMarksRead: true,
      notifyCategories: { important: true, secondary: true, ignore: false },
      agent
    },
    {
      enabled: true,
      configured: true,
      gateway: { state: "online", reconnectAttempt: 0 },
      bound: true,
      maskedRecipient: "abcd...5678"
    }
  );
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(openId), false);
  assert.equal(response.qq.hasAppSecret, true);
  assert.equal(response.qqStatus.maskedRecipient, "abcd...5678");
  assert.equal(response.wechat.enabled, true);
  assert.equal(response.enabled, true);
});
