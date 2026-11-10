// 触屏「回车=换行」拦截（client/mobile-enter.js）行为测试：
// 裸 Enter 在 composer 编辑器上被拦并重派发 shiftKey=true 的合成 keydown
//（复用官方 Shift+Enter 换行通路）；修饰键 Enter / IME 组字 / 桌面环境 /
// 非 composer 目标 / 组字结束 50ms 内的迟到 keydown 均原样放行。
// 用假 document/navigator/matchMedia 模拟浏览器环境，不依赖 DOM 实现。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { installMobileEnter } = await import('../client/mobile-enter.js');

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

/** 假环境：document 只记录监听器；Element 是可 new 的哑类。
 *  menuHighlighted 模拟「触发菜单开着且有高亮项」（menuHasHighlight 的 querySelector 结果）。 */
function fakeEnv({ coarse = true, ua = ANDROID_UA, platform = 'Linux armv8l', maxTouchPoints = 5, menuHighlighted = false } = {}) {
  const listeners = [];
  class Element {}
  const env = {
    Element,
    navigator: { userAgent: ua, platform, maxTouchPoints },
    matchMedia: (q) => ({ matches: coarse && q === '(pointer: coarse)' }),
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init = {}) { Object.assign(this, { type, ...init }); }
    },
    document: {
      documentElement: { dataset: {} },
      addEventListener(type, fn) { listeners.push({ type, fn }); },
      querySelector: (sel) => (menuHighlighted && sel.includes('data-trigger-menu') ? {} : null),
    },
  };
  return { env, listeners };
}

/** composer DOM 哑元：编辑器（contenteditable）在卡片容器内。 */
function composerDom(env) {
  const card = new env.Element();
  const editor = new env.Element();
  editor.closest = (sel) => (sel === '[data-composer-input][contenteditable="true"]' || sel === '[data-composer-input]' ? editor : sel === '[data-composer-card]' ? card : null);
  return { editor, card };
}

/** 构造捕获监听器收到的 keydown 哑事件。 */
function keyEvent(env, editor, over = {}) {
  const calls = { prevented: 0, stopped: 0, dispatched: [] };
  const event = {
    key: 'Enter', code: 'Enter', keyCode: 13,
    shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    isComposing: false, repeat: false,
    target: editor,
    preventDefault: () => { calls.prevented++; },
    stopImmediatePropagation: () => { calls.stopped++; },
    ...over,
  };
  editor.dispatchEvent = (synthetic) => { calls.dispatched.push(synthetic); };
  return { event, calls };
}

function keydownListener(listeners) {
  const l = listeners.find((x) => x.type === 'keydown');
  assert.ok(l, '应注册 keydown 捕获监听');
  return l.fn;
}

function compositionEndListener(listeners) {
  const l = listeners.find((x) => x.type === 'compositionend');
  assert.ok(l, '应注册 compositionend 捕获监听');
  return l.fn;
}

test('触屏 composer 裸 Enter：拦截并重派发 shiftKey=true 的合成 keydown', () => {
  const { env, listeners } = fakeEnv();
  installMobileEnter(env);
  const { editor } = composerDom(env);
  const { event, calls } = keyEvent(env, editor);

  keydownListener(listeners)(event);

  assert.equal(calls.prevented, 1, '原事件应 preventDefault（阻止浏览器原生插入）');
  assert.equal(calls.stopped, 1, '原事件应 stopImmediatePropagation（Lexical 不再收到）');
  assert.equal(calls.dispatched.length, 1, '应重派发一个合成 keydown');
  const synthetic = calls.dispatched[0];
  assert.equal(synthetic.type, 'keydown');
  assert.equal(synthetic.key, 'Enter');
  assert.equal(synthetic.shiftKey, true, '合成事件应带 shiftKey——走官方 Shift+Enter 换行通路');
  assert.equal(synthetic.bubbles, true);
  assert.equal(synthetic.isComposing, undefined, '合成事件不在组字状态');
  assert.equal(event.keyCode, 13, '原事件 keyCode 不被篡改');
});

test('触屏 composer：修饰键组合（Shift/Ctrl/Meta/Alt+Enter）原样放行', () => {
  for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) {
    const { env, listeners } = fakeEnv();
    installMobileEnter(env);
    const { editor } = composerDom(env);
    const { event, calls } = keyEvent(env, editor, { [mod]: true });

    keydownListener(listeners)(event);

    assert.equal(calls.prevented + calls.stopped + calls.dispatched.length, 0, `${mod} 组合不应被拦`);
  }
});

test('IME 安全：isComposing / keyCode 229 / 组字刚结束（Safari 迟到 keydown）均不拦', () => {
  for (const over of [{ isComposing: true }, { keyCode: 229 }]) {
    const { env, listeners } = fakeEnv();
    installMobileEnter(env);
    const { editor } = composerDom(env);
    const { event, calls } = keyEvent(env, editor, over);
    keydownListener(listeners)(event);
    assert.equal(calls.dispatched.length, 0, `${JSON.stringify(over)} 不应被拦`);
  }

  const { env, listeners } = fakeEnv();
  installMobileEnter(env);
  const { editor } = composerDom(env);
  compositionEndListener(listeners)({ target: editor });
  const { event, calls } = keyEvent(env, editor);
  keydownListener(listeners)(event);
  assert.equal(calls.dispatched.length, 0, 'compositionend 后 50ms 内的迟到 keydown 应交还官方处理');
});

test('桌面环境（pointer: fine + 桌面 UA）不拦，裸 Enter 照旧发送', () => {
  const { env, listeners } = fakeEnv({ coarse: false, ua: DESKTOP_UA, platform: 'Win32', maxTouchPoints: 0 });
  installMobileEnter(env);
  const { editor } = composerDom(env);
  const { event, calls } = keyEvent(env, editor);
  keydownListener(listeners)(event);
  assert.equal(calls.prevented + calls.stopped + calls.dispatched.length, 0);
});

test('桌面模式 iPad（MacIntel + 多点触控）视为触屏，裸 Enter 换行', () => {
  const { env, listeners } = fakeEnv({ coarse: false, ua: DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5 });
  installMobileEnter(env);
  const { editor } = composerDom(env);
  const { event, calls } = keyEvent(env, editor);
  keydownListener(listeners)(event);
  assert.equal(calls.dispatched.length, 1);
});

test('非 composer 目标（普通 textarea/设置输入框）不拦', () => {
  const { env, listeners } = fakeEnv();
  installMobileEnter(env);
  const plain = new env.Element();
  plain.closest = () => null; // 无 data-composer-input 祖先
  const { event, calls } = keyEvent(env, plain);
  keydownListener(listeners)(event);
  assert.equal(calls.prevented + calls.stopped + calls.dispatched.length, 0);
});

test('斜杠命令/@ 引用菜单开着且有高亮项：放行官方 arbitrate 选中逻辑，不拦', () => {
  const { env, listeners } = fakeEnv({ menuHighlighted: true });
  installMobileEnter(env);
  const { editor } = composerDom(env);
  const { event, calls } = keyEvent(env, editor);
  keydownListener(listeners)(event);
  assert.equal(calls.prevented + calls.stopped + calls.dispatched.length, 0, '菜单高亮时 Enter 应由官方选中处理');
});

test('菜单开着但无高亮（候选加载中）：照常拦截换行（对齐桌面提交路径）', () => {
  const { env, listeners } = fakeEnv({ menuHighlighted: false });
  installMobileEnter(env);
  const { editor } = composerDom(env);
  const { event, calls } = keyEvent(env, editor);
  keydownListener(listeners)(event);
  assert.equal(calls.dispatched.length, 1);
});

test('重复安装幂等：监听器只注册一次', () => {
  const { env, listeners } = fakeEnv();
  installMobileEnter(env);
  installMobileEnter(env);
  assert.equal(listeners.filter((x) => x.type === 'keydown').length, 1);
  assert.equal(listeners.filter((x) => x.type === 'compositionend').length, 1);
});

test('无 document 的环境（异常注入场景）静默跳过', () => {
  assert.doesNotThrow(() => installMobileEnter({}));
});
