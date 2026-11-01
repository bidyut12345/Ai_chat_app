import puppeteer from 'puppeteer';

// Test that file-changes renders at the end of the assistant message, not user message
async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle0' });

  // Evaluate in page context: mock state with user and assistant messages, plus fileChanges
  const evalResult = await page.evaluate(() => {
    // Inject mock conversation state
    window.state = window.state || {};
    window.state.messages = [
      { id: 101, role: 'user', content: 'Please modify the config and code files.', created_at: '2026-10-31 12:00:00' },
      { id: 102, role: 'assistant', content: 'I have updated the files as requested.', created_at: '2026-10-31 12:00:05' }
    ];
    window.state.fileChanges = [
      { id: 1, message_id: 101, path: 'C:/project/config.json', rel_path: 'config.json', added: 4, removed: 1 },
      { id: 2, message_id: 101, path: 'C:/project/index.js', rel_path: 'index.js', added: 12, removed: 3 }
    ];

    // Call renderMessages()
    if (typeof window.renderMessages === 'function') {
      window.renderMessages();
    }

    const userMsg = document.querySelector('.msg.user[data-id="101"]');
    const assistantMsg = document.querySelector('.msg.assistant[data-id="102"]');

    const userHasChanges = !!userMsg?.querySelector('.file-changes');
    const assistantHasChanges = !!assistantMsg?.querySelector('.file-changes');
    const changesCount = assistantMsg?.querySelectorAll('.file-change-row').length || 0;
    const summaryText = assistantMsg?.querySelector('.file-changes summary')?.textContent || '';

    return {
      userHasChanges,
      assistantHasChanges,
      changesCount,
      summaryText
    };
  });

  console.log('Result:', JSON.stringify(evalResult, null, 2));

  // Screenshot assistant message
  const assistantEl = await page.$('.msg.assistant[data-id="102"]');
  if (assistantEl) {
    await assistantEl.screenshot({ path: 'scratch/assistant-file-changes.png' });
    console.log('Saved screenshot to scratch/assistant-file-changes.png');
  }

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

