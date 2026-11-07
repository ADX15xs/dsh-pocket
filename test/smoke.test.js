// 真实链路冒烟测试：不注入任何 stub，验证「真实代理转发 + polyfill 注入 + 状态快照 + RPC」。
// 之前的教训：测试全用 stub 会漏掉真实环境才出现的 bug（如 require 崩溃、未处理 rejection）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPocketService } from '../lib/service.mjs';
import { installPocketRpc } from '../lib/web-rpc.js';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../client/api.js';

/** 假 dsh web：返回一个简单 HTML 文档（走真实 qrcode / 真实代理，无 stub）。 */
async function fakeUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>dsh</title></head><body>real-dsh</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function fakeCtxConnection() {
  let handler = null;
  const handle = (channel, fn) => {
    assert.equal(channel, POCKET_RPC_CHANNEL);
    handler = fn;
    return () => { handler = null; };
  };
  return { rpc: { handle }, get handler() { return handler; } };
}

/** 假 dsh web（压缩版）：浏览器若接受 gzip 就返回 gzip 的 HTML —— 复刻 dsh web 的真实行为
 *  （实测首页 41KB 压到 7.5KB）。用来验证注入不会因为上游压缩而整体静默失效。 */
async function fakeCompressingUpstream(seen) {
  const server = createServer((req, res) => {
    const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
    seen.push({ url: req.url, acceptEncoding, accept: String(req.headers.accept ?? '') });
    const isAsset = /\.(?:js|css|woff2?)$/i.test(String(req.url));
    const body = Buffer.from(isAsset
      ? 'console.log("asset")'
      : '<!doctype html><html><head><title>dsh</title></head><body>real-dsh-gzip</body></html>');
    const type = isAsset ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    if (!isAsset && /\bgzip\b/.test(acceptEncoding)) {
      const gz = gzipSync(body);
      res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': String(gz.length) });
      res.end(gz);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('真实链路：上游压缩的 HTML 也照样注入（issue #58 的前置条件）', async () => {
  const seen = [];
  const up = await fakeCompressingUpstream(seen);
  const home = await mkdtemp(join(tmpdir(), 'smoke-gzip-'));
  const service = createPocketService({ dshPort: up.address().port, port: 0, home });
  try {
    await service.startProxy();
    const st = await service.status();

    // 浏览器文档请求：带 text/html + gzip。上游本会压缩，代理必须先把它降级成 identity，
    // 否则 injectHtml 分支（!isCompressed 才注入）整段跳过 —— polyfill / transport 兜底 /
    // 页内信任声明全都到不了浏览器。
    const doc = await fetch(`http://127.0.0.1:${st.proxyPort}/`, {
      headers: { accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'gzip, deflate, br' },
    });
    const html = await doc.text();
    assert.equal(doc.status, 200);
    assert.ok(html.includes('real-dsh-gzip'), '代理转发到上游');
    assert.ok(html.includes('randomUUID'), '压缩上游下 polyfill 仍被注入');
    const docSeen = seen.find((s) => s.accept.includes('text/html'));
    assert.equal(docSeen.acceptEncoding, 'identity', 'HTML 文档请求向上游要未压缩形态');

    // 资源请求：不带 text/html → 压缩通道保持不动
    const asset = await fetch(`http://127.0.0.1:${st.proxyPort}/app.js`, {
      headers: { accept: '*/*', 'accept-encoding': 'gzip, deflate, br' },
    });
    await asset.arrayBuffer();
    const assetSeen = seen.find((s) => s.url === '/app.js');
    assert.match(assetSeen.acceptEncoding, /gzip/, 'JS/CSS 资源照常走压缩');
  } finally {
    await service.dispose();
    await new Promise((r) => up.close(r));
    await rm(home, { recursive: true, force: true });
  }
});

test('真实链路：代理转发 + polyfill 注入 + 状态快照（无 stub）', async () => {
  const up = await fakeUpstream();
  const home = await mkdtemp(join(tmpdir(), 'smoke-'));
  const service = createPocketService({ dshPort: up.address().port, port: 0, home });
  try {
    await service.startProxy();
    const st = await service.status();
    assert.equal(st.proxyRunning, true);
    assert.ok(st.proxyPort > 0, '拿到真实监听端口');

    // 真实代理转发到假 dsh web，且 HTML 被注入 randomUUID polyfill
    const res = await fetch(`http://127.0.0.1:${st.proxyPort}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('real-dsh'), '代理转发到上游');
    assert.ok(html.includes('randomUUID'), '非安全上下文 polyfill 已注入');

    // 状态快照：局域网 URL + 真实 qrcode 生成的二维码
    assert.ok(st.lanUrl.startsWith('http://'), '局域网 URL');
    assert.ok(st.lanQr.startsWith('data:image/png;base64,'), '真实 qrcode 生成的二维码');
  } finally {
    await service.dispose();
    await new Promise((r) => up.close(r));
    await rm(home, { recursive: true, force: true });
  }
});

test('真实链路：RPC status 走真实 service（含 restartNotice）', async () => {
  const up = await fakeUpstream();
  const home = await mkdtemp(join(tmpdir(), 'smoke-rpc-'));
  const service = createPocketService({ dshPort: up.address().port, port: 0, home });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, { service, log: { error() {}, warn() {} } });
  try {
    await service.startProxy();
    const r = await conn.handler(POCKET_ENDPOINTS.status, {});
    assert.equal(r.ok, true);
    assert.equal(r.value.proxyRunning, true);
    assert.ok(r.value.proxyPort > 0);
    assert.ok(r.value.lanQr.startsWith('data:image/png;base64,'), 'RPC 返回真实二维码');
    assert.equal(r.value.restartNotice, null, '无重启标记');
  } finally {
    await service.dispose();
    await new Promise((r) => up.close(r));
    await rm(home, { recursive: true, force: true });
  }
});

test('client bundle 注入 React 模块（PR #1 回归：设置页 JSX 曾 React is not defined）', async () => {
  // DSH 模块系统提供 react 为模块、非全局；esbuild 将设置页 JSX 编译为
  // import_react.createElement，因此 factory 必须能提供 react 模块。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('var import_react = require("react")'), 'factory 注入 React 模块');
  // 匹配实际调用形式（带左括号），避免命中 build.mjs 注释里的字面量
  assert.ok(src.includes('(0, import_react.createElement)('), 'bundle 内存在 JSX 编译产物（需要 React 模块）');
  const injectIdx = src.indexOf('var import_react = require("react")');
  const createIdx = src.indexOf('(0, import_react.createElement)(');
  assert.ok(injectIdx !== -1 && createIdx !== -1 && injectIdx < createIdx, 'React 模块声明先于使用');
});

test('client bundle：status 访问必须可选链（回归：1.9.0 白屏——首次渲染 status=null 时裸 status.lanAuthEnabled 抛 TypeError）', async () => {
  // load() 是异步的：首次渲染时 status 为 null。LAN 开关行渲染在 lanUrl 安全分支之外，
  // 1.9.0 在这里裸访问 status.lanAuthEnabled → React 整树崩溃 → 设置页白屏。
  // 修复：全部 status?.lanAuthEnabled。此测试防止再次出现裸访问（esbuild 会原样保留 ?.）。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('status.lanAuthEnabled'), 'bundle 不允许裸 status.lanAuthEnabled（必须可选链）');
  assert.ok(src.includes('status?.lanAuthEnabled'), 'bundle 存在可选链访问');
});

test('公网免责声明（issue #31）：bundle 含弹框与勾选逻辑，RPC 必须带 disclaimer 确认', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('disclaimer'), 'bundle 含免责声明逻辑');
  assert.ok(src.includes('disclaimer: true'), '开启公网带免责声明确认参数');
});

test('Windows 更新 spawn（PR #54）：performUpdate 的 spawn 必须带 shell 选项', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf("spawn('dsh'"), src.indexOf('spawn(\'dsh\')') + 500);
  assert.ok(src.includes("shell: process.platform === 'win32'"), 'spawn 带 shell: win32（npm shim ENOENT / Node22 EINVAL）');
});
