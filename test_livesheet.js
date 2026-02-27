const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));

  await page.goto('http://localhost:3000/scorekeeper.html', { waitUntil: 'networkidle0' });

  // Set up match
  await page.click('input[value="FIBA"]');
  await page.type('#draftNumber', '4');
  await page.type('#draftName', 'John');
  await page.evaluate(() => addDraftPlayer());
  await page.evaluate(() => { document.getElementById('draftTeamSelect').value = 'B'; });
  await page.type('#draftNumber', '5');
  await page.type('#draftName', 'Mike');
  await page.evaluate(() => addDraftPlayer());
  await page.evaluate(() => startMatch());

  // Click View Live Sheet
  await page.evaluate(() => openLiveSheet());

  await browser.close();
})();
