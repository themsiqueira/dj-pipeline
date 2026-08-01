import test from "node:test";
import assert from "node:assert/strict";
import { resolveProxy, sourceNetworkArgs, redactProxyForLog } from "../src/networkArgs.js";

function withProxy(value, fn) {
  const previous = process.env.YOUTUBE_DJ_PROXY;
  if (value === undefined) {
    delete process.env.YOUTUBE_DJ_PROXY;
  } else {
    process.env.YOUTUBE_DJ_PROXY = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.YOUTUBE_DJ_PROXY;
    } else {
      process.env.YOUTUBE_DJ_PROXY = previous;
    }
  }
}

test("no proxy configured adds no arguments", () => {
  withProxy(undefined, () => {
    assert.equal(resolveProxy(), "");
    assert.deepEqual(sourceNetworkArgs(), []);
  });
  withProxy("   ", () => {
    assert.deepEqual(sourceNetworkArgs(), []);
  });
});

test("supported schemes pass through to --proxy", () => {
  for (const proxy of [
    "socks5://127.0.0.1:1080",
    "socks5h://127.0.0.1:1080",
    "socks4://10.0.0.2:9050",
    "http://proxy.internal:3128",
    "https://user:secret@proxy.internal:3128"
  ]) {
    withProxy(proxy, () => {
      assert.deepEqual(sourceNetworkArgs(), ["--proxy", proxy], proxy);
    });
  }
});

test("a typo fails immediately instead of downloading unproxied", () => {
  withProxy("127.0.0.1:1080", () => {
    assert.throws(() => resolveProxy(), /not a URL/);
  });
  withProxy("ftp://proxy.internal:21", () => {
    assert.throws(() => resolveProxy(), /unsupported proxy scheme/);
  });
  withProxy("http://", () => {
    assert.throws(() => resolveProxy(), /not a URL|missing a host/);
  });
});

test("credentials are stripped before a proxy reaches the log", () => {
  assert.equal(
    redactProxyForLog("https://alice:secret@proxy.internal:3128"),
    "https://***@proxy.internal:3128"
  );
  assert.doesNotMatch(redactProxyForLog("socks5://alice:secret@host:1080"), /secret/);
  assert.equal(redactProxyForLog("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(redactProxyForLog(""), "");
});
