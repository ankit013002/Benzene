import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { navigationAction, pairingCodeFromLog, validateOrigin, validateSettings } from "./config.js";

test("normalizes desktop service origins and storage settings", () => {
  assert.deepEqual(validateSettings({
    appUrl: "https://vault.example/",
    gatewayUrl: "http://192.168.1.8:8080/",
    allocationGb: 100,
    deviceName: "  Studio Mac  ",
  }), {
    appUrl: "https://vault.example",
    gatewayUrl: "http://192.168.1.8:8080",
    allocationGb: 100,
    deviceName: "Studio Mac",
  });
});

test("rejects unsafe or malformed service addresses", () => {
  assert.throws(() => validateOrigin("file:///tmp/app", "Vault app address"), /HTTP or HTTPS/);
  assert.throws(() => validateOrigin("https://user:pass@example.com", "Gateway address"), /cannot contain credentials/);
  assert.throws(() => validateOrigin("https://example.com/login", "Vault app address"), /without a path/);
  assert.throws(() => validateOrigin("http://example.com", "Gateway address"), /must use HTTPS/);
  assert.equal(validateOrigin("https://example.com", "Gateway address"), "https://example.com");
  assert.equal(validateOrigin("http://192.168.1.4:8080", "Gateway address"), "http://192.168.1.4:8080");
});

test("allows only HTTP(S) navigation and classifies malformed URLs as denied", () => {
  assert.equal(navigationAction("https://vault.example/files", "https://vault.example"), "internal");
  assert.equal(navigationAction("https://identity.example/login", "https://vault.example"), "external");
  assert.equal(navigationAction("http://localhost:3000/devices", "http://localhost:3000"), "internal");
  assert.equal(navigationAction("javascript:alert(1)", "https://vault.example"), "deny");
  assert.equal(navigationAction("file:///etc/passwd", "https://vault.example"), "deny");
  assert.equal(navigationAction("not a URL", "https://vault.example"), "deny");
});

test("setup page CSP permits its packaged local bundle and blocks network access", () => {
  const html = readFileSync("src/setup.html", "utf8");
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /<script src="\.\.\/built\/setup\.js"><\/script>/);
});

test("requires a positive whole gigabyte allocation and a computer name", () => {
  assert.throws(() => validateSettings({ appUrl: "http://localhost:3000", gatewayUrl: "http://localhost:8080", allocationGb: 0, deviceName: "Mac" }), /whole number/);
  assert.throws(() => validateSettings({ appUrl: "http://localhost:3000", gatewayUrl: "http://localhost:8080", allocationGb: 100, deviceName: " " }), /Computer name/);
});

test("extracts only the current short-lived agent pairing code", () => {
  assert.equal(pairingCodeFromLog("This device is waiting to join a vault.\nApprove it with the code: abcd-2efg.\n"), "ABCD-2EFG");
  assert.equal(pairingCodeFromLog("Approve it with the code: ABCD-EFGH\n[agent] enrolled as device 123"), undefined);
  assert.equal(pairingCodeFromLog("[agent] enrolled as device 123"), undefined);
});
