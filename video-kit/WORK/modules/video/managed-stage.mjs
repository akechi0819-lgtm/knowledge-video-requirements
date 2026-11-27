// The host page and the model's scene live in separate origins. The iframe is
// the Main Stage viewport, so even viewport-relative scene elements are clipped.
const sceneUrl = 'https://video.invalid/scenes/scene.html';
const topHeight = 56;
const subtitleHeight = 112;
export const creditHold = 3;

export function managedStageLayout(video, { topBar = false, tailCard = true } = {}) {
  return {
    width: video.width,
    height: video.height - subtitleHeight - (topBar ? topHeight : 0),
    top: topBar ? topHeight : 0,
    topBar,
    tailCard,
  };
}

export function creditTitles(sections) {
  const sources = new Set();
  for (const { facts = [] } of sections) for (const fact of facts) {
    const titles = [...fact.matchAll(/(?:来源|出处|参见|见|据)\s*[：:]?\s*《([^》]+)》/gu)];
    for (const [, title] of titles) sources.add(title);
    if (titles.length) continue;
    for (const [, host] of fact.matchAll(/https?:\/\/([a-z0-9.-]+)/giu)) sources.add(host);
  }
  return [...sources];
}

async function seekScene(stage, t) {
  await window.seek(t);
  const visible = element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const bounds = stage.getBoundingClientRect();
  const right = Math.min(window.innerWidth, bounds.right), bottom = Math.min(window.innerHeight, bounds.bottom);
  const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
  const protectedText = [...document.querySelectorAll('[data-protected-text]')].filter(visible);
  const rectangles = protectedText.map(element => {
    const rect = element.getBoundingClientRect();
    if (rect.left < left || rect.top < top || rect.right > right || rect.bottom > bottom) {
      throw new Error(`保护文本越出主舞台：${element.dataset.protectedText || element.textContent.trim().slice(0, 40)}`);
    }
    return rect;
  });
  for (const [index, a] of rectangles.entries()) for (const b of rectangles.slice(index + 1)) {
    if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) throw new Error('主舞台保护文本相互重叠');
  }
}

function activeShot(stage) {
  const bounds = stage.getBoundingClientRect();
  const active = [stage, ...stage.querySelectorAll('[data-shot-id]')]
    .filter(element => {
      if (!element.dataset.shotId || !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const rect = element.getBoundingClientRect();
      return Math.min(rect.right, bounds.right, window.innerWidth) > Math.max(rect.left, bounds.left, 0)
        && Math.min(rect.bottom, bounds.bottom, window.innerHeight) > Math.max(rect.top, bounds.top, 0);
    })
    .map(element => element.dataset.shotId);
  return active.length === 1 ? active[0] : null;
}

function updateShell(root, { title, caption, credit }) {
  const top = root.querySelector('header');
  const footer = root.querySelector('footer');
  const main = root.querySelector('iframe');
  if (top) top.firstElementChild.textContent = title;
  footer.firstElementChild.textContent = credit || caption;
  footer.classList.toggle('credit', Boolean(credit));
  const outer = root.getBoundingClientRect();
  const slots = [top, main, footer].filter(Boolean).map(element => element.getBoundingClientRect());
  for (const [index, slot] of slots.entries()) {
    if (slot.top < outer.top || slot.bottom > outer.bottom || slot.left < outer.left || slot.right > outer.right) throw new Error('宿主槽位越出画布');
    if (index > 0 && slots[index - 1].bottom > slot.top) throw new Error('宿主槽位相互重叠');
  }
  for (const slot of [top, footer].filter(Boolean)) {
    const text = slot.firstElementChild;
    const bounds = slot.getBoundingClientRect(), rect = text.getBoundingClientRect();
    if (rect.top < bounds.top || rect.bottom > bounds.bottom || rect.left < bounds.left || rect.right > bounds.right || text.scrollHeight > text.clientHeight || (slot === footer && text.scrollWidth > text.clientWidth)) {
      throw new Error(`宿主文字超出保护槽位：${text.textContent.slice(0, 40)}`);
    }
  }
}

export async function openManagedStage(context, style, plan) {
  const page = await context.newPage();
  const { width, height, topBar } = plan.stage;
  const sceneStyle = { ...style, video: { ...style.video, width, height } };
  await page.addInitScript(([s, p, origin]) => {
    if (location.href !== origin) return;
    window.STYLE = s;
    window.__PLAN__ = p;
    window.RTCPeerConnection = undefined;
    window.webkitRTCPeerConnection = undefined;
  }, [sceneStyle, plan, sceneUrl]);
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden}
    #host-frame{width:${style.video.width}px;height:${style.video.height}px;display:flex;flex-direction:column;overflow:hidden;background:#fff}
    iframe{display:block;flex:none;width:${width}px;height:${height}px;border:0;overflow:hidden;background:#fff}
    header,footer{flex:none;box-sizing:border-box;overflow:hidden;background:#17191f;color:#f9fafb;display:grid;align-items:center;padding:0 40px;font-family:system-ui,sans-serif}
    header{height:${topHeight}px;font-size:22px;font-weight:600}
    header span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    footer{height:${subtitleHeight}px;text-align:center;font-size:30px;line-height:1.3;font-weight:600}
    footer span{white-space:pre-wrap;overflow-wrap:anywhere}
    footer.credit{font-size:23px;font-weight:400}
    </style><div id="host-frame">${topBar ? '<header><span></span></header>' : ''}
    <iframe title="主舞台" src="${sceneUrl}" sandbox="allow-scripts allow-same-origin" scrolling="no"></iframe>
    <footer><span></span></footer></div>`);
  const scene = page.frame({ url: sceneUrl });
  if (!scene) throw new Error('未加载主舞台镜头页面');
  await scene.waitForFunction('typeof window.seek === "function" && !!window.__PLAN__ && !!window.STYLE');
  const stage = scene.locator('#stage');
  const view = page.locator('#host-frame');
  return {
    view,
    async seek(t) {
      const caption = plan.captions.find(cue => t >= cue.start && t < cue.end)?.text || '';
      const credit = plan.credits?.find(cue => t >= cue.start && t < cue.end)?.text || '';
      try {
        await Promise.all([stage.evaluate(seekScene, t), view.evaluate(updateShell, { title: plan.title, caption, credit })]);
      } catch (error) {
        throw new Error(`[${plan.beatId}] ${t.toFixed(3)}s：${error.message}`);
      }
    },
    shotId: () => stage.evaluate(activeShot),
    caption: () => view.locator('footer span').textContent(),
  };
}
