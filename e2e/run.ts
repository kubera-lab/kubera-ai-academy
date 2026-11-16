// End-to-end test of the built site (run `npm run build && npx vite preview --port 4173` first).
// Walks through every lesson of every course in a real browser, with wrong answers first,
// then checks stale passes, reload, export/backup, Russian UI, keyboard, accessibility (axe) and mobile.
import { chromium, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { COURSES, ALL_LESSONS } from '../src/content/catalog.ts';
import { MODULES, RIVERSIDE_INSTRUCTIONS, SPOT_ITEMS } from '../src/data/course.ts';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173/';
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const EVIDENCE = 'Checked the risk to people, money, health and law; compared the UPRN, postcode and address with the source report';
const GOOD_PROMPT = 'You are a friendly helper for customers of Spoke & Chain Bike Repair. Answer only from the price list below. If the answer is not in the price list, say "I don\'t know" and never guess. Then suggest calling the shop on 020 0000 2222. Keep every answer short and simple, in two sentences or fewer. Do not answer questions about other topics.';
const STUFFED = 'You are a helper for Spoke & Chain Bike Repair. only facts only facts don\'t know never guess phone call short simple only facts don\'t know never guess phone call short simple only facts don\'t know never guess phone short simple only facts';

async function status(p: Page): Promise<string> {
  const pill = p.locator('section.card.task [role=status] .pill').last();
  await pill.waitFor({ timeout: 8000 });
  return (await pill.textContent()) ?? '';
}

async function answerLesson(p: Page, id: string, mode: 'right' | 'wrong'): Promise<string> {
  const l = ALL_LESSONS.find((x) => x.id === id)!;
  const ex = l.exercise;
  if (ex.kind === 'choice') {
    for (let i = 0; i < ex.questions.length; i++) {
      const q = ex.questions[i];
      const pick = mode === 'right' ? q.correct : (q.correct + 1) % q.options.length;
      await p.locator('fieldset.q').nth(i).locator('input[type=radio]').nth(pick).check();
    }
    await p.getByRole('button', { name: 'Check answers' }).click();
  } else if (ex.kind === 'classify') {
    for (let i = 0; i < ex.items.length; i++) {
      const it = ex.items[i];
      const fs = p.locator('fieldset.qa').nth(i);
      const labelId = mode === 'right' ? it.correct : ex.labels.find((x) => x.id !== it.correct)!.id;
      await fs.getByLabel(ex.labels.find((x) => x.id === labelId)!.label.en, { exact: true }).check();
      if (it.evidence) await fs.getByLabel('One-line evidence (required)').fill(mode === 'right' ? EVIDENCE : 'x');
    }
    await p.getByRole('button', { name: 'Check answers' }).click();
  } else if (ex.kind === 'order') {
    if (mode === 'right') {
      for (let i = 0; i < ex.correct.length; i++) {
        const want = ex.steps.find((s) => s.id === ex.correct[i])!.text.en;
        let texts = await p.locator('ol.order li > span:first-child').allTextContents();
        let j = texts.indexOf(want);
        while (j > i) { await p.getByRole('button', { name: `Move step ${j + 1} up` }).click(); j--; }
        texts = await p.locator('ol.order li > span:first-child').allTextContents();
      }
    }
    await p.getByRole('button', { name: 'Check answers' }).click();
  } else if (ex.kind === 'sql') {
    await p.getByLabel('Your SQL query').fill(mode === 'right' ? ex.reference : "SELECT 'Mitcham', 3, 275000");
    await p.getByRole('button', { name: 'Check (visible + hidden data)' }).click();
  } else if (ex.kind === 'code') {
    await p.getByLabel('Your JavaScript').fill(mode === 'right' ? ex.reference : ex.starter);
    await p.getByRole('button', { name: 'Run tests' }).click();
  } else if (ex.kind === 'prompt') {
    await p.getByLabel('Your instructions').fill(mode === 'right' ? GOOD_PROMPT : STUFFED);
    await p.getByRole('button', { name: 'Run the checks' }).click();
  }
  return status(p);
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs: string[] = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const go = async (h: string) => { await p.goto(BASE + '#' + h); await p.waitForTimeout(120); };

  await go('home');
  check('home shows 8 course cards', (await p.locator('article.ccard').count()) === 8);
  check('no "Coming soon" cards', (await p.getByText('Coming soon').count()) === 0);

  // ---------- every lesson, wrong first, then right ----------
  const triedWrong = new Set<string>();
  for (const c of COURSES.filter((x) => !x.legacy)) {
    for (const l of c.lessons) {
      await go('l/' + l.id);
      if (!triedWrong.has(l.exercise.kind) || l.lab) {
        triedWrong.add(l.exercise.kind);
        const w = await answerLesson(p, l.id, 'wrong');
        check(`${l.id}: wrong answer is not passed`, w.startsWith('Not yet'), w);
        if (l.id === 'dq-4') check('dq-4: evidence "x" explained', (await p.getByText('Evidence is too short').count()) > 0);
        if (l.id === 'sql-1') check('sql-1: hard-coded answer explained', (await p.locator('.fbline.bad').count()) > 0);
        if (l.exercise.kind === 'choice' || l.exercise.kind === 'classify') {
          check(`${l.id}: first wrong attempt hides the answer`, (await p.getByText('The explanation is shown after the second attempt').count()) > 0);
        }
      }
      const r = await answerLesson(p, l.id, 'right');
      check(`${l.id}: correct work passes`, r.startsWith('Passed'), r);
      check(`${l.id}: lesson marked passed`, (await p.locator('.donecard h2').textContent()) === 'Lesson passed');
    }
  }

  // ---------- code timeout ----------
  await go('l/web-1');
  await p.getByLabel('Your JavaScript').fill('function formatPrice(p) { while (true) {} }');
  await p.getByRole('button', { name: 'Run tests' }).click();
  const to = await status(p);
  check('endless loop is stopped and reported', to.startsWith('Not yet') && (await p.getByText('more than 2 seconds').count()) > 0, to);
  check('lesson no longer passed after failing re-run', (await p.locator('.donecard').count()) === 0);
  await answerLesson(p, 'web-1', 'right');

  // ---------- stale pass after editing ----------
  await go('l/sql-1');
  const q = p.getByLabel('Your SQL query');
  await q.fill((await q.inputValue()) + ' ');
  check('editing a passed query shows "changed since last check"', (await p.getByText('Your work changed since the last check').count()) > 0);
  check('edited lesson is not counted as passed', (await p.locator('.donecard').count()) === 0);
  await go('c/sql');
  check('course page shows the change', (await p.getByText('changed since last check').count()) > 0);
  await go('l/sql-1');
  await answerLesson(p, 'sql-1', 'right');

  // ---------- course 3 (original assistant course) ----------
  const quiz = async (mod: (typeof MODULES)[number]) => {
    for (let i = 0; i < mod.quiz.length; i++) await p.locator('fieldset.q').nth(i).locator('input[type=radio]').nth(mod.quiz[i].correct).check();
    await p.getByRole('button', { name: 'Check answers' }).click();
  };
  await go('m1'); await quiz(MODULES[0]);
  const lab: Record<string, string> = { correct: 'Correct', invented: 'Invented', refusal: 'Good refusal' };
  for (let i = 0; i < SPOT_ITEMS.length; i++) await p.locator('fieldset.qa').nth(i).getByLabel(lab[SPOT_ITEMS[i].correct], { exact: true }).check();
  await p.getByRole('button', { name: 'Check labels' }).click();
  check('course 3 · module 1 complete', (await p.locator('.card[role=status] h2').textContent()) === 'Module complete');
  await go('m2'); await quiz(MODULES[1]);
  await p.getByLabel('Your instructions').fill(RIVERSIDE_INSTRUCTIONS + ' If you are not sure, use your own general knowledge.');
  await p.getByRole('button', { name: 'Run the checks' }).click();
  check('course 3 · contradictory prompt fails', (await p.locator('.card[role=status] h2').textContent()) !== 'Module complete');
  await p.getByLabel('Your instructions').fill(RIVERSIDE_INSTRUCTIONS);
  await p.getByRole('button', { name: 'Run the checks' }).click();
  check('course 3 · module 2 complete', (await p.locator('.card[role=status] h2').textContent()) === 'Module complete');
  await go('m3'); await quiz(MODULES[2]);
  const addEntry = async (qq: string, k: string, a: string, s: string) => { await p.getByRole('button', { name: 'Add entry' }).click(); const e = p.locator('.kb').last(); await e.getByLabel('Typical question').fill(qq); await e.getByLabel('Keywords (comma-separated)').fill(k); await e.getByLabel('Answer').fill(a); await e.getByLabel('Source fact no.').fill(s); };
  await addEntry('What is your phone number?', 'phone, call, telephone, number, contact', 'You can call us on 020 0000 0000.', '4');
  await addEntry('Is it accessible?', 'wheelchair, step-free, lift, stairs, access, first floor', 'There is step-free access to the ground floor. There is no lift to the first floor.', '5');
  await p.getByRole('button', { name: 'Run all tests' }).click();
  check('course 3 · module 3 complete', (await p.locator('.card[role=status] h2').textContent()) === 'Module complete');
  await go('m4'); await quiz(MODULES[3]);
  const kb = p.locator('.card.task').nth(1).locator('.kb');
  await kb.nth(0).getByLabel('Answer').fill('We are open Monday to Friday 9:00 to 17:00 and Saturday 10:00 to 14:00. We are closed on Sunday.');
  await kb.nth(2).getByLabel('Answer').fill('The computer room is free. Book at reception. You can use it for a maximum of 2 hours per person per day.');
  await kb.nth(3).getByLabel('Keywords (comma-separated)').fill('phone, telephone, number, call, contact');
  await p.getByLabel('Out-of-scope topics (comma-separated)').fill('weather, football, politics, news');
  await p.getByRole('button', { name: 'Run all tests' }).click();
  check('course 3 · module 4 complete', (await p.locator('.card[role=status] h2').textContent()) === 'Module complete');
  await go('m5'); await quiz(MODULES[4]);
  await go('project');
  await p.locator('#tpl').selectOption('library'); await p.getByRole('button', { name: 'Load template' }).click(); await p.getByRole('button', { name: 'Replace' }).click();
  const L = JSON.parse(readFileSync(new URL('./library.json', import.meta.url), 'utf8'));
  const s1 = p.locator('section.card').nth(0);
  await s1.getByLabel('Assistant name').fill(L.config.name);
  await s1.getByLabel('Purpose (one sentence)').fill(L.config.purpose);
  const s2 = p.locator('section.card').nth(1);
  await s2.getByLabel('Your instructions').fill(L.config.instructions);
  await s2.getByLabel(`"I don't know" reply (must give a real next step)`).fill(L.config.unknownReply);
  await s2.getByLabel('Out-of-scope topics (comma-separated)').fill(L.config.outOfScopeTopics);
  await s2.getByLabel('Out-of-scope reply').fill(L.config.outOfScopeReply);
  const s3 = p.locator('section.card').nth(2);
  for (const e of L.config.kb) { await s3.getByRole('button', { name: 'Add entry' }).click(); const k = s3.locator('.kb').last(); await k.getByLabel('Typical question').fill(e.question); await k.getByLabel('Keywords (comma-separated)').fill(e.keywords); await k.getByLabel('Answer').fill(e.answer); await k.getByLabel('Source fact no.').fill(String(e.source)); }
  const s4 = p.locator('section.card').nth(3);
  for (const tc of L.tests) { await s4.getByRole('button', { name: 'Add test' }).click(); const k = s4.locator('.kb:not(details .kb)').last(); await k.getByLabel('Question').fill(tc.input); await k.getByLabel('Kind').selectOption(tc.category); await k.getByLabel('Expected behaviour').selectOption(tc.expectKind); await k.getByLabel('Must contain').fill(tc.mustContain); }
  await p.getByRole('button', { name: 'Check acceptance criteria' }).click();
  check('course 3 · own final project meets all criteria', (await p.locator('.card.task .row .pill').first().textContent()) === 'All acceptance criteria met.');
  await go('m5');
  check('course 3 · module 5 complete', (await p.locator('.card[role=status] h2').textContent()) === 'Module complete');

  // ---------- dashboard, reload ----------
  await go('dashboard');
  const tiles = async () => (await p.locator('.tiles .tile b').allTextContents()).join(',');
  const all = '4 / 4,4 / 4,5 / 5,4 / 4,4 / 4,4 / 4,4 / 4,4 / 4';
  check('dashboard: every course complete', (await tiles()) === all, await tiles());
  check('learning history recorded', (await p.locator('table.results tbody tr').count()) >= 30);
  await p.reload(); await p.waitForTimeout(200);
  check('progress survives reload', (await tiles()) === all, await tiles());

  // ---------- portfolio & backup ----------
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Download portfolio (.md)' }).click()]);
  const md = readFileSync((await dl.path())!, 'utf8');
  check('portfolio downloads with results, solutions and limits', /Limitations/.test(md) && /filterListings/.test(md) && /GROUP BY uprn/.test(md) && /It is not a certificate/.test(md));
  const [bk] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Download progress backup (.json)' }).click()]);
  const backupPath = (await bk.path())!;
  await p.getByRole('button', { name: 'Reset all progress' }).click();
  await p.getByRole('button', { name: 'Delete everything' }).click();
  check('reset clears progress', (await tiles()).startsWith('0 / 4'), await tiles());
  await p.locator('label.filebtn input[type=file]').setInputFiles(backupPath);
  await p.waitForTimeout(300);
  check('backup restores progress', (await tiles()) === all, await tiles());

  // ---------- Russian ----------
  await go('l/sql-1');
  await p.getByRole('button', { name: 'RU', exact: true }).click();
  check('html lang switches to ru', (await p.evaluate(() => document.documentElement.lang)) === 'ru');
  check('lesson title in Russian', /[А-Яа-я]/.test((await p.locator('h1').textContent()) ?? ''));
  const englishUi = ['Check answers', 'Sources & further reading', 'Run tests', 'Lesson passed', 'Dashboard', 'Courses', 'Your SQL query', 'Run on practice data'];
  const body = await p.locator('body').innerText();
  check('no untranslated UI labels on a Russian lesson page', englishUi.every((s) => !body.includes(s)), englishUi.filter((s) => body.includes(s)).join(', '));
  for (const h of ['home', 'courses', 'dashboard', 'about', 'search', 'm2', 'project', 'l/agents-2', 'l/dq-4', 'l/web-4']) {
    await go(h);
    const txt = await p.locator('body').innerText();
    const leaks = ['Check answers', 'Run tests', 'Learning history', 'Knowledge check', 'Final project', 'Lesson ', 'Try again', 'Open course'].filter((s) => txt.includes(s));
    check(`RU #${h}: no English UI labels`, leaks.length === 0, leaks.join(', '));
  }
  await p.getByRole('button', { name: 'EN', exact: true }).click();

  // ---------- keyboard only ----------
  const k = await ctx.newPage();
  await k.goto(BASE + '#home');
  await k.keyboard.press('Tab');
  check('first Tab focuses the skip link', (await k.evaluate(() => document.activeElement?.className)) === 'skip');
  await k.goto(BASE + '#l/agents-1');
  await k.locator('button', { hasText: 'Start the task again' }).focus();
  await k.keyboard.press('Enter');
  const ex1 = ALL_LESSONS.find((x) => x.id === 'agents-1')!.exercise as Extract<(typeof ALL_LESSONS)[number]['exercise'], { kind: 'choice' }>;
  for (let i = 0; i < ex1.questions.length; i++) {
    await k.locator('fieldset.q').nth(i).locator('input[type=radio]').nth(0).focus();
    for (let n = 0; n < ex1.questions[i].correct; n++) await k.keyboard.press('ArrowDown');
    await k.keyboard.press('Space');
  }
  await k.getByRole('button', { name: 'Check answers' }).focus();
  const outline = await k.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  await k.keyboard.press('Enter');
  check('lesson completed with keyboard only', (await k.locator('.donecard h2').textContent()) === 'Lesson passed');
  check('focus outline visible', outline !== 'none', outline);
  await k.goto(BASE + '#l/agents-2');
  await k.getByRole('button', { name: 'Start the task again' }).focus();
  await k.keyboard.press('Enter');
  await k.getByRole('button', { name: 'Move step 2 up' }).focus();
  await k.keyboard.press('Enter');
  check('ordering works with the keyboard', (await k.locator('ol.order li > span:first-child').first().textContent())?.startsWith('Read the room calendar') ?? false);

  // ---------- accessibility (axe-core) ----------
  const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  for (const h of ['home', 'courses', 'c/sql', 'l/fund-2', 'l/agents-2', 'l/sql-3', 'l/gis-4', 'l/prompt-4', 'l/dq-4', 'm3', 'project', 'dashboard', 'search', 'about']) {
    await p.goto(BASE + '#' + h); await p.waitForTimeout(150);
    await p.addScriptTag({ content: axeSrc });
    const v = await p.evaluate(async () => {
      const r = await (window as unknown as { axe: { run: (o: object) => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe.run({ resultTypes: ['violations'] });
      return r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}(${x.nodes.length})`);
    });
    check(`axe: no serious/critical issues on #${h}`, v.length === 0, v.join(' '));
  }

  // ---------- mobile 390 px ----------
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  m.on('pageerror', (e) => errs.push('mobile ' + e.message));
  for (const h of ['home', 'courses', 'l/sql-2', 'l/gis-4', 'l/dq-4', 'l/agents-2', 'm3', 'project', 'dashboard', 'about']) {
    await m.goto(BASE + '#' + h); await m.waitForTimeout(150);
    const sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(`mobile 390px #${h}: no horizontal scroll`, sw <= 390, String(sw));
  }
  await m.goto(BASE + '#home');
  await m.getByRole('button', { name: 'Menu' }).click();
  check('mobile menu opens', (await m.locator('nav.open a').count()) === 5);
  await m.screenshot({ path: 'e2e/out-mobile-home.png' });
  await m.goto(BASE + '#l/sql-1'); await m.screenshot({ path: 'e2e/out-mobile-sql.png', fullPage: true });
  await p.goto(BASE + '#l/web-4'); await p.screenshot({ path: 'e2e/out-desktop-lab.png', fullPage: true });

  check('no console or page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  await b.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nE2E: ${results.length - failed.length} of ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
