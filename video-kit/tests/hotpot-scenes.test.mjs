import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('only the five-section demo with both original photos prepares', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hotpot-scene-'));
  try {
    await writeFile(path.join(dir,'table.png'), Buffer.from('image'));
    const sections = Array.from({length:5}, (_,i) => ({id:`S0${i+1}`,blueprintId:`B0${i+1}`,narration:'这是一句旁白。', ...([0,4].includes(i)?{image:'table.png'}:{})}));
    const input = path.join(dir,'production.json');
    await writeFile(input,JSON.stringify({status:'准备制作', sections}));
    await run(process.execPath,[fileURLToPath(new URL('../scripts/hotpot-scenes.mjs', import.meta.url)),'--input',input,'--output',path.join(dir,'scenes')]);
    const output = JSON.parse(await readFile(path.join(dir,'scenes/production.json'),'utf8'));
    assert.deepEqual(output.sections.map(s=>s.scene),['S01.html','S02.html','S03.html','S04.html','S05.html']);
    const second = await readFile(path.join(dir,'scenes/S02.html'),'utf8');
    assert.match(second,/href="S01-table\.png"/);
    assert.match(second,/wordAt\(p/);
    assert.match(await readFile(path.join(dir,'scenes/S04.html'),'utf8'),/Natural Earth/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
