// 触屏设备上「回车 = 换行」：手机/平板浏览器打开 dsh web 时，composer 输入框里
// 裸 Enter 不再发送消息，而是换行（发送走发送按钮）——微信式触屏输入习惯。
//
// 官方 DSH composer 是 Lexical contenteditable（编辑器根 [data-composer-input]，
// 卡片容器 [data-composer-card]），裸 Enter 经 KEY_ENTER_COMMAND 直接提交
//（ui-conversation keymap.ts，COMMAND_PRIORITY_CRITICAL），官方无移动端分支；
// 唯一官方换行通路是 Shift+Enter（落到 @lexical/plain-text 默认，在 Lexical
// 模型内插 LineBreakNode）。
//
// 实现：document 捕获阶段拦截 composer 编辑器上的裸 Enter（先于 Lexical 绑在
// 编辑器根元素上的监听器），preventDefault + stopImmediatePropagation 后在编辑器
// 元素上重派发一个 shiftKey=true 的合成 keydown——完整复用官方 Shift+Enter 通路，
// 零模型失同步风险；发送按钮（click 路径）不受影响，Ctrl/Cmd/Alt+Enter 加速提交
// 照旧放行。
//
// 触发菜单放行：官方输入触发菜单（斜杠命令 / @ 引用，ui-input-trigger MenuView，
// DOM 根带 data-trigger-menu）开着且带高亮项时，裸 Enter 会被官方 arbitrate 消费
//（选中高亮项；refinement 挂起期间是显式 no-op）——此时放行，与桌面行为一致。
// 高亮状态在 DOM 上的落点是 listbox 的 aria-activedescendant / 高亮 option 的
// aria-selected="true"。菜单开着但尚无高亮（候选加载中）桌面是提交，这里照常换行。
//
// 触屏判定：pointer: coarse（主输入为触摸），或官方 isMobileDevice 同款 UA/iPad
// 判定（ui-primitives focus.ts：Android/iPhone/iPod UA，或 MacIntel + 多点触控
// 的桌面模式 iPad）。桌面键鼠环境两个条件都不满足，行为不变。
//
// IME 安全：isComposing / keyCode 229（部分厂商 IME 全键 229）期间不拦；
// compositionend 后 50ms 内迟到的 keydown（Safari 特性）也不拦，交还官方
// recentlyComposing 逻辑——与桌面 IME 行为完全一致。

const MOBILE_UA = /Android|iPhone|iPad|iPod/i;
// 触发菜单开着且有高亮项（任一命中即官方会消费 Enter）
const MENU_HIGHLIGHT_SELECTOR = '[data-trigger-menu] [aria-activedescendant],'
  + ' [data-trigger-menu] [role="option"][aria-selected="true"]';

export function installMobileEnter(env = globalThis) {
  const doc = env.document;
  if (!doc || doc.documentElement.dataset.dshpMobileEnter === '1') return;
  doc.documentElement.dataset.dshpMobileEnter = '1';

  const isTouch = () => (env.matchMedia?.('(pointer: coarse)').matches ?? false)
    || MOBILE_UA.test(env.navigator?.userAgent ?? '')
    || (env.navigator?.platform === 'MacIntel' && (env.navigator?.maxTouchPoints ?? 0) > 1);

  const menuHasHighlight = () => doc.querySelector(MENU_HIGHLIGHT_SELECTOR) !== null;

  // 官方 keymap 的 Safari 迟到 keydown 兜底窗口：只跟踪 composer 内的组字
  let compositionEndAt = 0;
  doc.addEventListener('compositionend', (e) => {
    if (e.target instanceof env.Element && e.target.closest('[data-composer-input]')) {
      compositionEndAt = Date.now();
    }
  }, true);

  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (Date.now() - compositionEndAt < 50) return;
    if (!(event.target instanceof env.Element)) return;
    const editor = event.target.closest('[data-composer-input][contenteditable="true"]');
    if (!editor || !editor.closest('[data-composer-card]')) return;
    if (!isTouch()) return;
    if (menuHasHighlight()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    editor.dispatchEvent(new env.KeyboardEvent('keydown', {
      key: 'Enter', code: event.code, bubbles: true, cancelable: true,
      shiftKey: true, repeat: event.repeat,
    }));
  }, true);
}
