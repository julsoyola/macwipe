import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(directory);
const tool=process.env.DEMO_VIDEO_TOOL||path.resolve(root,'..','project-demo-video');
const args=process.argv.slice(2);
const {retentionCLI,freshExportPath}=await import(pathToFileURL(path.join(tool,'lib','retention.mjs')));
if(await retentionCLI({root:path.join(directory,'.local'),workflow:'browser',args,legacyFinals:[path.join(os.homedir(),'Downloads','MacWipe-Feature-Demo.mp4')]}))process.exit(process.exitCode||0);
assert.ok(args.every(arg=>['--check','--archive-existing','--keep-intermediates'].includes(arg)),'Unknown demo option.');
const {recordDemo}=await import(pathToFileURL(path.join(tool,'lib','recorder.mjs')));
const sequence=JSON.parse(await readFile(path.join(directory,'sequence.json'),'utf8'));
const stylesheet=await readFile(path.join(root,sequence.theme.paletteSource),'utf8');
for(const color of Object.values(sequence.theme.colors))assert.ok(stylesheet.includes(color),`Palette color missing from source: ${color}`);
const checked=new Map();
let capacityBefore;
const row=id=>`#item-table-body tr:has(input[data-item="${id}"])`;
async function visible(page,selector){await page.locator(selector).waitFor({state:'visible'});}
async function details(page,helpers,id,content){
  await helpers.click(`[data-details="${id}"]`);
  await visible(page,'#details-dialog[open]');
  assert.ok((await page.locator('#details-dialog').innerText()).includes(content));
}
async function select(page,helpers,id){
  const selector=`input[data-item="${id}"]`;
  assert.equal(await page.locator(selector).isChecked(),false);
  await helpers.click(selector);
  assert.equal(await page.locator(selector).isChecked(),true);
  checked.set(id,await page.locator(selector).elementHandle());
}
const actions={
  async home(page,{check}){
    await visible(page,'#home-view');
    for(const selector of ['.storage-ring','.downloads-card','.caches-card','.home-system-status'])await visible(page,selector);
    capacityBefore=await page.locator('#storage-usage').innerText();
    assert.ok(capacityBefore.length);
    check('Home uses the supplied example data',{capacity:capacityBefore});
  },
  hoverChart:(page,{move})=>move('.storage-ring'),
  hoverExplore:(page,{move})=>move('[data-action="explore-storage"]'),
  async explore(page,{click}){await click('[data-action="explore-storage"]');await visible(page,'#file-list');},
  async explorerRoots(page,{click,check}){
    if(!await page.locator('[data-explorer-id="example-documents"]').count())await click('#btn-explorer-scan');
    await visible(page,'[data-explorer-id="example-documents"]');
    assert.ok((await page.locator('#item-table-body').innerText()).includes('Pictures'));
    assert.equal(await page.locator('#item-table-body input:enabled').count(),0);
    check('Explorer is read-only and shows the real example roots',true);
  },
  async documents(page,{click,check}){
    await click('[data-explorer-id="example-documents"]');
    assert.ok((await page.locator('#item-table-body').innerText()).includes('Archive.zip'));
    await visible(page,'[data-explorer-id="example-projects"]');check('Documents contains Archive.zip and Projects',true);
  },
  async projects(page,{click,check}){
    await click('[data-explorer-id="example-projects"]');
    assert.ok((await page.locator('#item-table-body').innerText()).includes('Project.mov'));
    check('Projects contains Project.mov',true);
  },
  async breadcrumb(page,{click}){await click('#explorer-breadcrumbs [data-explorer-id="example-documents"]');},
  backHome:(page,{click})=>click('[data-action="back-home"]'),
  async downloads(page,{click}){
    await click('nav [data-category="downloads"]');
    for(const id of ['installer','archive','document'])await visible(page,`input[data-item="${id}"]`);
  },
  async sortDownloads(page,{click,check}){
    const header=page.locator('th:has(#btn-sort-size)');
    for(let i=0;i<3&&await header.getAttribute('aria-sort')!=='descending';i++)await click('#btn-sort-size');
    assert.equal(await header.getAttribute('aria-sort'),'descending');
    assert.deepEqual(await page.locator('#item-table-body input').evaluateAll(nodes=>nodes.map(node=>node.dataset.item)),['installer','archive','document']);
    check('Downloads really sorted descending',['installer','archive','document']);
  },
  installerDetails:(page,h)=>details(page,h,'installer','Modification time does not establish'),
  closeDetails:async(page,{click})=>{await click('#details-dialog [data-close]');assert.equal(await page.locator('#details-dialog').evaluate(node=>node.open),false);},
  archiveDetails:(page,h)=>details(page,h,'archive','Modification time does not establish'),
  async keepArchive(page,{click}){assert.equal((await page.locator('#btn-keep-item').innerText()).trim(),'Keep this');await click('#btn-keep-item');},
  async verifyKept(page,{check}){
    const archive=page.locator('input[data-item="archive"]');
    assert.equal(await archive.isDisabled(),true);assert.equal(await archive.isChecked(),false);
    assert.ok((await page.locator(row('archive')).innerText()).includes('Kept'));
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('macwipe.demo.keptIDs'))),['archive']);
    check('Keep persists the exclusion, disables selection and leaves archive unchecked',true);
  },
  caches:(page,{click})=>click('nav [data-category="caches"]'),
  browserCacheDetails:(page,h)=>details(page,h,'browser-cache','Apps may recreate these files'),
  selectThumbnail:(page,h)=>select(page,h,'thumbnail-cache'),
  selectInstaller:(page,h)=>select(page,h,'installer'),
  async verifySelection(page,{check}){
    assert.deepEqual([...checked.keys()].sort(),['installer','thumbnail-cache']);
    for(const handle of checked.values())assert.equal(await handle.evaluate(node=>node.checked),true);
    assert.equal(await page.locator('input[data-item="archive"]').isChecked(),false);
    assert.equal(await page.locator('input[data-item="archive"]').isDisabled(),true);
    assert.match(await page.locator('#selection-status').innerText(),/^Selected: 2 items/);
    check('Exactly the two individually chosen IDs are selected',['installer','thumbnail-cache']);
  },
  async review(page,{click,check}){
    await click('#btn-review-selected');await visible(page,'#review-dialog[open]');
    const items=await page.locator('#review-items-list li').allTextContents();
    assert.equal(items.length,2);
    assert.ok(items.some(text=>text.startsWith('Previous installer.dmg ·')));
    assert.ok(items.some(text=>text.startsWith('Thumbnail cache ·')));
    assert.ok(items.every(text=>!text.includes('archive')));
    assert.match(await page.locator('#review-total-size').innerText(),/505/);
    assert.match(await page.locator('#review-notice').innerText(),/Demo only.*Simulation clears/s);
    assert.equal((await page.locator('#review-simulate-btn').innerText()).trim(),'Simulate cleanup');
    check('Review contains precisely the chosen two items, honest total and demo notice',items);
  },
  simulate:(page,{click})=>click('#review-simulate-btn'),
  async verifyResult(page,{check}){
    assert.match(await page.locator('#selection-status').innerText(),/^Selected: 0 items/);
    assert.equal(await page.locator('#btn-review-selected').isDisabled(),true);
    for(const handle of checked.values())assert.equal(await handle.evaluate(node=>node.checked),false);
    assert.equal(await page.locator('#item-table-body input').count(),3);
    for(const id of ['installer','archive','document'])assert.equal(await page.locator(`input[data-item="${id}"]`).count(),1);
    assert.equal(await page.locator('#storage-usage').innerText(),capacityBefore);
    assert.equal(await page.locator('input[data-item="archive"]').isDisabled(),true);
    check('Simulation resets selections; no rows or available-space values are changed',true);
  },
  restCursor:(page,{move})=>move('#dashboard-heading'),
};
try { await recordDemo({keepIntermediates:args.includes('--keep-intermediates'),verifyOnly:process.argv.includes('--check'),archiveExisting:process.argv.includes('--archive-existing'),projectRoot:root,sequenceFile:path.join(directory,'sequence.json'),output:freshExportPath(path.join(os.homedir(),'Downloads'),'MacWipe-Feature-Demo.mp4'),actions,
  ready:async page=>{
    await visible(page,'#home-view');
    assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('native-mode')),false);
    assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);
    assert.match(await page.locator('.demo-tag').innerText(),/Example data/);
  },
}); } catch { process.exitCode=1; }
