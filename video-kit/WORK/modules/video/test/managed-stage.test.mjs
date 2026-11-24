import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import STYLE from '../style.mjs';
import { creditTitles, managedStageLayout, openManagedStage } from '../managed-stage.mjs';

const require = createRequire(import.meta.url);
test('reads books and source domains from confirmed facts for the host end card', () => {
  assert.deepEqual(creditTitles([
    { facts: ['见《一本书》 https://source.example/book', '另一份资料 https://science.example/articles/9。'] },
    { facts: ['见《一本书》', '见 https://science.example/elsewhere', '普通事实'] },
  ]), ['一本书', 'science.example']);
});

test('host stage clips fixed model elements and checks only registered protection boxes', {
  skip: !STYLE.paths.edge || !STYLE.paths.playwright,
}, async () => {
  const { chromium } = require(STYLE.paths.playwright);
  const browser = await chromium.launch({ executablePath: STYLE.paths.edge, headless: true });
  try {
    const style = { ...STYLE, video: { ...STYLE.video, width: 480, height: 360 } };
    const context = await browser.newContext({ viewport: { width: 480, height: 360 } });
    await context.route('https://video.invalid/scenes/scene.html', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8">
      <style>body{margin:0}#stage{position:relative;height:100vh;background:white}
      #bleed{position:fixed;top:0;left:0;width:900px;height:900px;background:red}
      .text{position:absolute;left:20px;top:10px;width:100px;height:26px;background:white}</style>
      <div id="stage" data-shot-id="B01"><div id="bleed"></div>
        <div class="text" data-protected-text="主词">主词</div>
        <div id="addition" class="text">未登记文字与其他元素可以遮叠</div>
      </div><script>
      let isolated = false;
      try { window.parent.document.title = '受模型控制'; }
      catch { isolated = true; }
      const box = document.querySelector('#addition');
      window.seek = t => {
        if (!isolated || innerHeight !== window.__PLAN__.stage.height) throw Error('模型未与宿主隔离');
        if (t > 0) box.dataset.protectedText = '补充词';
        if (t > 1) box.style.top = '100vh';
      };
      </script>`,
    }));
    const stage = managedStageLayout(style.video, { topBar: true, tailCard: true });
    const page = await openManagedStage(context, style, {
      beatId: 'B01', title: '宿主说明', stage,
      captions: [{ text: '独立字幕', start: 0, end: 1 }],
      credits: [{ text: '资料来源 · 一份资料', start: 2, end: 4 }],
    });
    await page.seek(0);
    assert.equal(await page.shotId(), 'B01');
    assert.equal(await page.caption(), '独立字幕');
    assert.equal(await page.view.locator('header').textContent(), '宿主说明');
    assert.deepEqual(await page.view.locator('iframe').boundingBox(), { x: 0, y: 56, width: 480, height: 192 });
    assert.deepEqual(await page.view.locator('footer').boundingBox(), { x: 0, y: 248, width: 480, height: 112 });
    await assert.rejects(page.seek(0.5), /保护文本相互重叠/);
    await assert.rejects(page.seek(2.5), /保护文本越出主舞台/);
    // Slot text is always set by the host even when the scene fails protection checks.
    assert.equal(await page.caption(), '资料来源 · 一份资料');
  } finally {
    await browser.close();
  }
});
